// src/host/server-init.ts — Shared host initialization for server.ts.
//
// Encapsulates the duplicated setup: storage → routing → taint budget →
// template seeding → IPC socket → CompletionDeps → delegation →
// orchestrator → agent registry → createIPCHandler.

import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';
import type { Config, ProviderRegistry } from '../types.js';
import { axHome, dataDir } from '../paths.js';
import { createRouter, type Router } from './router.js';
import { createIPCHandler, createIPCServer, type DelegateRequest, type IPCContext } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { processCompletion, resolveMcpAuthHeaders, type CompletionDeps } from './server-completions.js';
import { createOrchestrator, type Orchestrator } from './orchestration/orchestrator.js';
import { FileStore } from '../file-store.js';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';
import type { EventBus } from './event-bus.js';
import type { MessageQueueStore, ConversationStoreProvider } from '../providers/storage/types.js';
import { createAgentRegistry, type AgentRegistry } from './agent-registry.js';
import { AgentProvisioner } from './agent-provisioner.js';
import type { Server as NetServer } from 'node:net';
import { callToolOnServer } from '../plugins/mcp-client.js';
import { loadDatabaseMcpServers } from '../plugins/startup.js';
import type { AdminContext } from './server-admin-helpers.js';
import type { SkillCredStore } from './skills/skill-cred-store.js';
import type { SkillDomainStore } from './skills/skill-domain-store.js';
import type { AdminOAuthProviderStore } from './admin-oauth-providers.js';
import { createAdminOAuthFlow, type AdminOAuthFlow } from './admin-oauth-flow.js';
import { createSnapshotCache } from './skills/snapshot-cache.js';
import type { SkillSnapshotEntry } from './skills/types.js';
import type { GetAgentSkillsDeps } from './skills/get-agent-skills.js';
import {
  syncToolModulesForSkill,
  type ToolModuleSyncInput,
  type ToolModuleSyncResult,
} from './skills/tool-module-sync.js';

const logger = getLogger();

export interface HostCoreOptions {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  verbose?: boolean;
  /** Per-agent plugin MCP server registry. */
  mcpManager?: import('../plugins/mcp-manager.js').McpConnectionManager;
}

export interface HostCore {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  db: MessageQueueStore;
  conversationStore: ConversationStoreProvider;
  sessionStore: ProviderRegistry['storage']['sessions'];
  router: Router;
  taintBudget: TaintBudget;
  fileStore: FileStore;
  gcsFileStorage?: import('./gcs-file-storage.js').GcsFileStorage;
  completionDeps: CompletionDeps;
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ipcServer: NetServer;
  ipcSocketPath: string;
  ipcSocketDir: string;
  orchestrator: Orchestrator;
  disableAutoState: () => void;
  agentRegistry: AgentRegistry;
  provisioner: AgentProvisioner;
  agentId: string;
  adminCtx: AdminContext;
  sessionCanaries: Map<string, string>;
  workspaceMap: Map<string, string>;
  defaultUserId: string;
  modelId: string;
  mcpManager?: import('../plugins/mcp-manager.js').McpConnectionManager;
  /** Tuple-keyed skill credential store. */
  skillCredStore?: SkillCredStore;
  /** Tuple-keyed skill domain approval store. */
  skillDomainStore?: SkillDomainStore;
  /** Phase 6 Task 1: symmetric key used to encrypt admin-registered OAuth
   *  client secrets at rest. Derived from `AX_OAUTH_SECRET_KEY` (preferred)
   *  or sha256(admin.token) as a fallback. Exposed so Task 2's CRUD endpoint
   *  handler can construct its own store views if needed. Undefined when
   *  no database provider is available. */
  adminOAuthKey?: Buffer;
  /** Phase 6 Task 1: admin-registered OAuth provider store. Pre-configured
   *  client_id + (encrypted) client_secret + redirect_uri per provider name,
   *  used by the OAuth start/callback flow in later phase-6 tasks to override
   *  a skill's frontmatter `client_id` (upgrading a public-client config to
   *  a confidential one). Undefined when no database provider is available. */
  adminOAuthProviderStore?: AdminOAuthProviderStore;
  /** Phase 6 Task 3: in-memory pending-flow map for admin-initiated OAuth.
   *  Keyed by state, single-use claim, 15-minute TTL. Constructed
   *  unconditionally (no DB deps) so the /admin/api/skills/oauth/start
   *  endpoint is available whenever the skill state store is wired. */
  adminOAuthFlow: AdminOAuthFlow;
  /** Dependencies for live `getAgentSkills` computation — shared between the
   *  per-turn skill-payload build (`processCompletion`) and the admin + hook
   *  reconcile paths. */
  agentSkillsDeps: GetAgentSkillsDeps;
  /** Resolves (cloning + fetching as needed) the local bare-repo path for an
   *  agent. Consumed by `agentSkillsDeps` for live snapshot walks. */
  getBareRepoPath: (agentId: string) => Promise<string>;
  /** Commits a skill's MCP tool modules into the agent's repo under
   *  `.ax/tools/<skillName>/`. Bound at construction time to mcpManager,
   *  skillCredStore, and providers.workspace. Throws when any of those is
   *  unavailable at call time. */
  syncToolModules: (input: ToolModuleSyncInput) => Promise<ToolModuleSyncResult>;
}

/**
 * Shared initialization for both server.ts (local) and host-process.ts (k8s).
 * Sets up storage, routing, IPC, template seeding, delegation, orchestrator.
 */
export async function initHostCore(opts: HostCoreOptions): Promise<HostCore> {
  const { config, providers, eventBus, verbose } = opts;

  // Create McpConnectionManager if not provided — needed for plugin/database
  // MCP server discovery and tool stub generation.
  const { McpConnectionManager } = await import('../plugins/mcp-manager.js');
  const mcpManager = opts.mcpManager ?? new McpConnectionManager();

  // ── Storage, routing, taint budget ──
  mkdirSync(dataDir(), { recursive: true });
  const db = providers.storage.messages;
  const conversationStore = providers.storage.conversations;
  const sessionStore = providers.storage.sessions;
  const fileStore = await FileStore.create(providers.database);

  // Create GCS file storage if GCS bucket is configured
  let gcsFileStorage: import('./gcs-file-storage.js').GcsFileStorage | undefined;
  const gcsBucket = config.gcs?.bucket;
  if (gcsBucket) {
    try {
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage();
      const bucket = storage.bucket(gcsBucket);
      const { createGcsFileStorage } = await import('./gcs-file-storage.js');
      gcsFileStorage = createGcsFileStorage(bucket, config.gcs?.prefix ?? '');
    } catch (err) {
      // Non-fatal: fall back to local disk storage
      const initLogger = (await import('../logger.js')).getLogger();
      initLogger.warn('gcs_file_storage_init_failed', { error: (err as Error).message });
    }
  }

  const taintBudget = new TaintBudget({ threshold: thresholdForProfile(config.profile) });
  const router = createRouter(providers, db, { taintBudget });

  // ── Agent identity ──
  const agentId = config.agent_name;

  // ── Template seeding — seed to DocumentStore only ──
  const templatesDir = resolveTemplatesDir();
  const documents = providers.storage.documents;

  // Identity and skills are git-native. Templates are seeded into the workspace
  // git repo by seedAxDirectory() in server-completions.ts on first creation.
  // No DocumentStore seeding needed.

  const defaultUserId = process.env.USER ?? 'default';

  // ── IPC socket ──
  // Use dataDir() on macOS so Docker Desktop can mount it (VirtioFS doesn't
  // support Unix sockets under /var/folders). On Linux, tmpdir() is fine.
  const ipcSocketBase = process.platform === 'darwin' ? dataDir() : tmpdir();
  const ipcSocketDir = mkdtempSync(join(ipcSocketBase, 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const sessionCanaries = new Map<string, string>();
  const workspaceMap = new Map<string, string>();

  // ── Git-native skills stores ──
  // Only created when a database provider is available; power the admin
  // skill-approval + setup endpoints.
  let skillCredStore: SkillCredStore | undefined;
  let skillDomainStore: SkillDomainStore | undefined;
  let adminOAuthKey: Buffer | undefined;
  let adminOAuthProviderStore: AdminOAuthProviderStore | undefined;

  // Phase 6 Task 3: admin-initiated OAuth pending-flow map. In-memory, no
  // DB deps — construct unconditionally so the endpoint is available
  // whenever a skill credential store is wired.
  const adminOAuthFlow = createAdminOAuthFlow();

  // Auto-generate admin.token if not configured — MUST happen before
  // `deriveOAuthKey` below. Otherwise, on a fresh install without
  // `AX_OAUTH_SECRET_KEY` set, `deriveOAuthKey('', ...)` would throw
  // (refusing sha256('') as an at-rest key), we'd log the misleading
  // "admin_oauth_provider_store_disabled" warning, and then
  // `createAdminHandler` would generate a token moments later — leaving
  // the OAuth provider store disabled even though a usable token DID get
  // generated. `createAdminHandler` still has the same guard as a
  // defensive no-op for callers that don't run through `initHostCore`
  // (e.g. unit tests that construct AdminDeps directly).
  const authDisabled = config.admin?.disable_auth === true;
  if (config.admin && !authDisabled && !config.admin.token) {
    config.admin.token = randomBytes(32).toString('hex');
    logger.info('admin_token_generated', { source: 'server-init' });
  }

  if (providers.database) {
    const { runMigrations } = await import('../utils/migrator.js');
    const { buildSkillsMigrations } = await import('../migrations/skills.js');
    const migResult = await runMigrations(
      providers.database.db,
      buildSkillsMigrations(providers.database.type),
      'skills_migration',
    );
    if (migResult.error) throw migResult.error;

    const { createSkillCredStore } = await import('./skills/skill-cred-store.js');
    const { createSkillDomainStore } = await import('./skills/skill-domain-store.js');
    skillCredStore = createSkillCredStore(providers.database.db, providers.database.type);
    skillDomainStore = createSkillDomainStore(providers.database.db);

    // Phase 6 Task 1: admin-registered OAuth providers. Run the migration
    // alongside the skills one (same Kysely instance, distinct migration
    // table name so their histories don't collide), derive the encryption
    // key, and construct the store so Task 2's CRUD endpoints can wire to
    // it without another round of setup.
    const { buildAdminOAuthMigrations } = await import('../migrations/admin-oauth-providers.js');
    const { deriveOAuthKey, createAdminOAuthProviderStore } =
      await import('./admin-oauth-providers.js');
    const oauthMigResult = await runMigrations(
      providers.database.db,
      buildAdminOAuthMigrations(providers.database.type),
      'admin_oauth_migration',
    );
    if (oauthMigResult.error) throw oauthMigResult.error;
    // Soft-degrade when no key source is configured: `deriveOAuthKey` throws
    // for installs without AX_OAUTH_SECRET_KEY AND without a sufficiently-long
    // admin.token (refusing sha256('') as an at-rest key). That's a valid
    // state for many dev loops, so we warn and skip constructing the store —
    // OAuth provider CRUD endpoints will 503, matching the DB-less case.
    try {
      const derived = deriveOAuthKey(
        config.admin?.token ?? '',
        process.env.AX_OAUTH_SECRET_KEY,
      );
      adminOAuthKey = derived.key;
      if (derived.derivedFrom === 'admin-token') {
        logger.warn('oauth_secret_key_derived_from_admin_token', {
          msg: 'AX_OAUTH_SECRET_KEY unset — derived from admin.token. Set a dedicated 32-byte key for production.',
        });
      }
      adminOAuthProviderStore = createAdminOAuthProviderStore(
        providers.database.db,
        adminOAuthKey,
      );
    } catch (err) {
      logger.warn('admin_oauth_provider_store_disabled', {
        msg: 'Admin-registered OAuth providers disabled — OAuth provider CRUD endpoints will return 503.',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Git-native skill snapshot plumbing ──
  // Delegate local-mirror management to the workspace provider. Each
  // provider owns its seeded-mirror set + clone configuration, so both
  // this snapshot-walker path AND `workspace.commitFiles` share the same
  // on-disk state. Previously there were two parallel paths — the one
  // here only ran `git clone --mirror` without unsetting
  // `remote.origin.mirror`, while `commitFiles` later expected a mirror
  // configured for refspec-push. The clone-without-unset silently left
  // the mirror in a state that broke pushes with "--mirror can't be
  // combined with refspecs".
  const execFileAsync = promisify(execFile);
  const getBareRepoPath = async (agentIdArg: string): Promise<string> => {
    if (providers.workspace) {
      return providers.workspace.ensureLocalMirror(agentIdArg);
    }
    // Fallback for setups with no workspace provider (e.g. pre-workspace
    // configs) — just return the expected local path.
    return join(axHome(), 'repos', encodeURIComponent(agentIdArg));
  };
  const probeHead = async (agentIdArg: string): Promise<string> => {
    const bareRepoPath = await getBareRepoPath(agentIdArg);
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', bareRepoPath, 'refs/heads/main'],
      { encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    );
    const line = stdout.split('\n').find((l) => l.trim().length > 0);
    if (!line) return '<empty>';
    const sha = line.split(/\s+/, 1)[0];
    return sha || '<empty>';
  };
  if (!skillCredStore || !skillDomainStore) {
    throw new Error(
      'skills subsystem requires a database provider — set providers.database in ax.yaml.',
    );
  }

  const snapshotCache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 1024 });
  const agentSkillsDeps: GetAgentSkillsDeps = {
    skillCredStore,
    skillDomainStore,
    getBareRepoPath,
    probeHead,
    snapshotCache,
    mcpManager,
  };

  // Tool-module sync closure. Binds the heavy deps (mcpManager + the DB-backed
  // skill cred store + workspace provider) so the admin approve + refresh-tools
  // routes can invoke it without knowing about them. Fails loud if the
  // workspace provider isn't wired — skill approval without a workspace to
  // commit into is a misconfiguration, not a runtime hazard.
  const syncToolModules = async (input: ToolModuleSyncInput): Promise<ToolModuleSyncResult> => {
    if (!providers.workspace) throw new Error('workspace provider required for syncToolModules');
    return syncToolModulesForSkill(
      { mcpManager, skillCredStore, workspace: providers.workspace },
      input,
    );
  };

  // ── CompletionDeps ──
  const completionDeps: CompletionDeps = {
    config,
    providers,
    db,
    conversationStore,
    router,
    taintBudget,
    sessionCanaries,
    ipcSocketPath,
    ipcSocketDir,
    logger,
    verbose,
    fileStore,
    gcsFileStorage,
    eventBus,
    workspaceMap,
    mcpManager,
    agentSkillsDeps,
    skillCredStore,
    skillDomainStore,
    // provisioner is set after agent registry creation below
  };

  // ── Delegation ──
  async function handleDelegate(req: DelegateRequest, ctx: IPCContext): Promise<string> {
    const tier = req.resourceTier ?? 'default';
    const tierConfig = tier === 'heavy'
      ? { memory_mb: 2048, cpus: 4 }
      : { memory_mb: config.sandbox.memory_mb, cpus: 1 };

    const childConfig = {
      ...config,
      ...(req.runner ? { agent: req.runner } : {}),
      ...(req.model ? { models: { default: [req.model] } } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      sandbox: {
        ...config.sandbox,
        memory_mb: tierConfig.memory_mb,
        cpus: tierConfig.cpus,
        ...(req.timeoutSec ? { timeout_sec: req.timeoutSec } : {}),
      },
    };
    const childDeps: CompletionDeps = { ...completionDeps, config: childConfig };
    const taskPrompt = req.context ? `${req.context}\n\n---\n\nTask: ${req.task}` : req.task;
    const requestId = req.requestId ?? `delegate-${randomUUID().slice(0, 8)}`;
    const result = await processCompletion(childDeps, taskPrompt, requestId, [], undefined, undefined, ctx.userId);
    return result.responseContent;
  }

  // ── Orchestrator + agent registry ──
  const orchestrator = createOrchestrator(eventBus, providers.audit);
  const disableAutoState = orchestrator.enableAutoState();
  const agentRegistry = await createAgentRegistry(providers.database);
  const provisioner = new AgentProvisioner(agentRegistry, providers.storage?.documents);
  completionDeps.provisioner = provisioner;

  // ── Ensure agent exists in registry ──
  const existingAgent = await agentRegistry.get(agentId);
  if (!existingAgent) {
    await agentRegistry.register({
      id: agentId,
      name: agentId,
      status: 'active',
      parentId: null,
      agentType: config.agent ?? 'pi-coding-agent',
      capabilities: [],
      createdBy: 'system',
      admins: [defaultUserId],
    });
  }

  // ── Admin context (DB-backed) ──
  const adminCtx: AdminContext = { registry: agentRegistry, agentId, workspace: providers.workspace };

  // ── IPC handler ──
  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentId,
    configModel: config.models?.default?.[0],
    onDelegate: handleDelegate,
    delegation: config.delegation ? {
      maxConcurrent: config.delegation.max_concurrent,
      maxDepth: config.delegation.max_depth,
    } : undefined,
    eventBus,
    orchestrator,
    workspaceMap,
    adminCtx,
    // Legacy: providers.mcp (database MCP provider) is kept as fallback for
    // tool batching. When all callers migrate to McpConnectionManager, remove
    // providers.mcp and the legacy fallback paths in tool-router.ts,
    // tool-batch.ts, inprocess.ts, and server-completions.ts.
    toolBatchProvider: (providers.mcp || mcpManager)
      ? {
          getProvider: providers.mcp ? () => providers.mcp! : () => null,
          resolveServer: mcpManager
            ? (agentId: string, toolName: string) => mcpManager.getToolServerUrl(agentId, toolName)
            : undefined,
          mcpCallTool: mcpManager ? callToolOnServer : undefined,
          getServerMetaByUrl: mcpManager
            ? (agentId: string, serverUrl: string) => mcpManager.getServerMetaByUrl(agentId, serverUrl)
            : undefined,
          resolveHeaders: providers.credentials
            ? async (h: Record<string, string>) => {
                const { resolveHeaders: rh } = await import('../providers/mcp/database.js');
                return rh(JSON.stringify(h), providers.credentials);
              }
            : undefined,
          // Resolve Bearer auth for skill-declared MCP servers from the
          // tuple-keyed `skill_credentials` store, not the legacy
          // `providers.credentials`. The skills SSoT migration moved
          // per-skill credentials off the generic key/value store; the
          // tool-batch call-time path was left pointing at the wrong
          // source and every turn-time tool call ended up sending no
          // Authorization header (symptom: Linear 401 invalid_token even
          // with a valid API key stored via the Approvals tab).
          //
          // `resolveMcpAuthHeaders` already has the right precedence
          // (user-scope → agent-scope sentinel → last-resort first row
          // → process.env fallback) — reuse it instead of rolling a
          // second lookup.
          authForServer: skillCredStore
            ? async (server: { name: string; url: string; agentId: string; userId: string }) =>
                resolveMcpAuthHeaders({
                  serverName: server.name,
                  agentId: server.agentId,
                  userId: server.userId,
                  skillCredStore,
                })
            : undefined,
        }
      : undefined,
    gcsFileStorage,
    fileStore,
  });
  completionDeps.ipcHandler = handleIPC;

  // ── Load MCP servers into the manager from the database ──
  if (mcpManager && providers.database) {
    await loadDatabaseMcpServers(providers.database, mcpManager);
  }

  const defaultCtx = { sessionId: 'server', agentId, userId: defaultUserId };
  const ipcServer = await createIPCServer(ipcSocketPath, handleIPC, defaultCtx);

  const modelId = providers.llm.name;

  return {
    config,
    providers,
    eventBus,
    db,
    conversationStore,
    sessionStore,
    router,
    taintBudget,
    fileStore,
    gcsFileStorage,
    completionDeps,
    handleIPC,
    ipcServer,
    ipcSocketPath,
    ipcSocketDir,
    orchestrator,
    disableAutoState,
    agentRegistry,
    provisioner,
    agentId,
    adminCtx,
    sessionCanaries,
    workspaceMap,
    defaultUserId,
    modelId,
    mcpManager,
    skillCredStore,
    skillDomainStore,
    adminOAuthKey,
    adminOAuthProviderStore,
    adminOAuthFlow,
    agentSkillsDeps,
    getBareRepoPath,
    syncToolModules,
  };
}
