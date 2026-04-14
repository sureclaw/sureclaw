// src/host/server-init.ts — Shared host initialization for both server-local.ts and server-k8s.ts.
//
// Encapsulates the duplicated setup: storage → routing → taint budget →
// template seeding → IPC socket → CompletionDeps → delegation →
// orchestrator → agent registry → createIPCHandler.

import { existsSync, readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.js';
import type { Config, ProviderRegistry } from '../types.js';
import { dataDir } from '../paths.js';
import { createRouter, type Router } from './router.js';
import { createIPCHandler, createIPCServer, type DelegateRequest, type IPCContext } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { createOrchestrator, type Orchestrator } from './orchestration/orchestrator.js';
import { FileStore } from '../file-store.js';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';
import type { EventBus } from './event-bus.js';
import type { MessageQueueStore, ConversationStoreProvider } from '../providers/storage/types.js';
import { createAgentRegistry, type AgentRegistry } from './agent-registry.js';
import { AgentProvisioner } from './agent-provisioner.js';
import { ProxyDomainList } from './proxy-domain-list.js';
import type { Server as NetServer } from 'node:net';
import { callToolOnServer } from '../plugins/mcp-client.js';
import { reloadPluginMcpServers, loadDatabaseMcpServers } from '../plugins/startup.js';
import type { AdminContext } from './server-admin-helpers.js';

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
  requestedCredentials: Map<string, Set<string>>;
  domainList: ProxyDomainList;
  defaultUserId: string;
  modelId: string;
  mcpManager?: import('../plugins/mcp-manager.js').McpConnectionManager;
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

  // Check DocumentStore for bootstrap completion
  let bootstrapAlreadyComplete = false;
  try {
    const dbSoul = await documents.get('identity', `${agentId}/SOUL.md`);
    const dbIdentity = await documents.get('identity', `${agentId}/IDENTITY.md`);
    bootstrapAlreadyComplete = !!(dbSoul && dbIdentity);
  } catch { /* DocumentStore may not support get-or-null, treat as not complete */ }

  // Identity files → DocumentStore
  for (const file of ['AGENTS.md', 'HEARTBEAT.md']) {
    const src = join(templatesDir, file);
    if (existsSync(src)) {
      const key = `${agentId}/${file}`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(src, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }

  // BOOTSTRAP.md + USER_BOOTSTRAP.md → DocumentStore
  // Always overwrite with latest template so stale instructions are refreshed.
  if (!bootstrapAlreadyComplete) {
    const src = join(templatesDir, 'BOOTSTRAP.md');
    if (existsSync(src)) {
      try {
        await documents.put('identity', `${agentId}/BOOTSTRAP.md`, readFileSync(src, 'utf-8'));
      } catch { /* non-fatal */ }
    }
    const ubSrc = join(templatesDir, 'USER_BOOTSTRAP.md');
    if (existsSync(ubSrc)) {
      try {
        await documents.put('identity', `${agentId}/USER_BOOTSTRAP.md`, readFileSync(ubSrc, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }

  // Skills seeding — seed to DocumentStore if no skills exist yet
  try {
    const { listSkills } = await import('../providers/storage/skills.js');
    const existingSkills = await listSkills(documents, agentId);
    if (existingSkills.length === 0) {
      const { seedSkillsDir: resolveSeedSkillsDir } = await import('../utils/assets.js');
      const seedDir = resolveSeedSkillsDir();
      if (existsSync(seedDir)) {
        const { readdirSync } = await import('node:fs');
        const seedEntries = readdirSync(seedDir, { withFileTypes: true });
        for (const entry of seedEntries) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            const content = readFileSync(join(seedDir, entry.name), 'utf-8');
            const skillName = entry.name.replace(/\.md$/, '');
            await documents.put('skills', `${agentId}/${skillName}`, content);
          } else if (entry.isDirectory()) {
            const skillMdPath = join(seedDir, entry.name, 'SKILL.md');
            if (existsSync(skillMdPath)) {
              const content = readFileSync(skillMdPath, 'utf-8');
              await documents.put('skills', `${agentId}/${entry.name}`, content);
            }
          }
        }
      }
    }
  } catch { /* non-fatal */ }

  const defaultUserId = process.env.USER ?? 'default';

  // ── IPC socket ──
  // Use dataDir() on macOS so Docker Desktop can mount it (VirtioFS doesn't
  // support Unix sockets under /var/folders). On Linux, tmpdir() is fine.
  const ipcSocketBase = process.platform === 'darwin' ? dataDir() : tmpdir();
  const ipcSocketDir = mkdtempSync(join(ipcSocketBase, 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const sessionCanaries = new Map<string, string>();
  const workspaceMap = new Map<string, string>();
  const requestedCredentials = new Map<string, Set<string>>();

  // ── Domain allowlist for proxy — populated from DB-stored skills ──
  const domainList = new ProxyDomainList();
  if (providers.storage?.documents) {
    const { parseAgentSkill } = await import('../utils/skill-format-parser.js');
    const { generateManifest } = await import('../utils/manifest-generator.js');
    const { listSkills } = await import('../providers/storage/skills.js');
    try {
      const skills = await listSkills(providers.storage.documents, agentId);
      for (const skill of skills) {
        try {
          const parsed = parseAgentSkill(skill.instructions);
          const manifest = generateManifest(parsed);
          if (manifest.capabilities.domains.length > 0) {
            domainList.addSkillDomains(parsed.name || skill.id, manifest.capabilities.domains);
          }
        } catch { /* skip unparseable */ }
      }
    } catch { /* documents not available */ }
  }

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
    requestedCredentials,
    domainList,
    mcpManager,
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
  const adminCtx: AdminContext = { registry: agentRegistry, documents, agentId };

  // ── IPC handler ──
  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentId,
    profile: config.profile,
    configModel: config.models?.default?.[0],
    onDelegate: handleDelegate,
    delegation: config.delegation ? {
      maxConcurrent: config.delegation.max_concurrent,
      maxDepth: config.delegation.max_depth,
    } : undefined,
    eventBus,
    orchestrator,
    agentRegistry,
    workspaceMap,
    requestedCredentials,
    domainList,
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
          authForServer: providers.credentials
            ? async (server: { name: string; url: string }) => {
                const prefix = server.name.toUpperCase().replace(/-/g, '_');
                const candidates = [
                  `${prefix}_API_KEY`, `${prefix}_ACCESS_TOKEN`,
                  `${prefix}_OAUTH_TOKEN`, `${prefix}_TOKEN`,
                ];
                for (const envName of candidates) {
                  const value = await providers.credentials.get(envName);
                  if (value) return { Authorization: `Bearer ${value}` };
                }
                return undefined;
              }
            : undefined,
        }
      : undefined,
    gcsFileStorage,
    fileStore,
  });
  completionDeps.ipcHandler = handleIPC;

  // ── Load MCP servers into the manager from plugins and database ──
  if (mcpManager && providers.storage?.documents) {
    await reloadPluginMcpServers(providers.storage.documents, mcpManager);
  }
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
    requestedCredentials,
    domainList,
    defaultUserId,
    modelId,
    mcpManager,
  };
}
