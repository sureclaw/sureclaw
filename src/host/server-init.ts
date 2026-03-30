// src/host/server-init.ts — Shared host initialization for both server-local.ts and server-k8s.ts.
//
// Encapsulates the duplicated setup: storage → routing → taint budget → agent dir →
// template seeding → skills seeding → admins → IPC socket → CompletionDeps → delegation →
// orchestrator → agent registry → createIPCHandler.

import { existsSync, readFileSync, mkdirSync, mkdtempSync, copyFileSync, cpSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.js';
import type { Config, ProviderRegistry } from '../types.js';
import { dataDir, agentDir as agentDirPath, agentIdentityDir, agentIdentityFilesDir, agentSkillsDir } from '../paths.js';
import { createRouter, type Router } from './router.js';
import { createIPCHandler, createIPCServer, type DelegateRequest, type IPCContext } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { createOrchestrator, type Orchestrator } from './orchestration/orchestrator.js';
import { FileStore } from '../file-store.js';
import { templatesDir as resolveTemplatesDir, seedSkillsDir as resolveSeedSkillsDir } from '../utils/assets.js';
import type { EventBus } from './event-bus.js';
import type { MessageQueueStore, ConversationStoreProvider } from '../providers/storage/types.js';
import { createAgentRegistry, type AgentRegistry } from './agent-registry.js';
import { ProxyDomainList } from './proxy-domain-list.js';
import type { Server as NetServer } from 'node:net';
import { callToolOnServer } from '../plugins/mcp-client.js';
import { reloadPluginMcpServers, loadDatabaseMcpServers } from '../plugins/startup.js';

const logger = getLogger();

export interface HostCoreOptions {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  verbose?: boolean;
  /** Per-agent plugin MCP server registry (Cowork plugins). */
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
  completionDeps: CompletionDeps;
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ipcServer: NetServer;
  ipcSocketPath: string;
  ipcSocketDir: string;
  orchestrator: Orchestrator;
  disableAutoState: () => void;
  agentRegistry: AgentRegistry;
  agentName: string;
  agentDirVal: string;
  identityFilesDir: string;
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
  const taintBudget = new TaintBudget({ threshold: thresholdForProfile(config.profile) });
  const router = createRouter(providers, db, { taintBudget });

  // ── Agent directory setup ──
  const agentName = 'main';
  const agentDirVal = agentDirPath(agentName);
  const agentConfigDir = agentIdentityDir(agentName);
  const identityFilesDir = agentIdentityFilesDir(agentName);
  mkdirSync(agentDirVal, { recursive: true });
  mkdirSync(agentConfigDir, { recursive: true });
  mkdirSync(identityFilesDir, { recursive: true });

  // Let scheduler know where the identity files dir is (for HEARTBEAT.md loading)
  config.scheduler.agent_dir = identityFilesDir;

  // ── Template seeding — seed to both filesystem and DocumentStore ──
  const templatesDir = resolveTemplatesDir();
  const documents = providers.storage.documents;

  // Check both filesystem AND DocumentStore for bootstrap completion
  const fsBootstrapComplete =
    existsSync(join(identityFilesDir, 'SOUL.md')) && existsSync(join(identityFilesDir, 'IDENTITY.md'));
  let dbBootstrapComplete = false;
  try {
    const dbSoul = await documents.get('identity', `${agentName}/SOUL.md`);
    const dbIdentity = await documents.get('identity', `${agentName}/IDENTITY.md`);
    dbBootstrapComplete = !!(dbSoul && dbIdentity);
  } catch { /* DocumentStore may not support get-or-null, treat as not complete */ }
  const bootstrapAlreadyComplete = fsBootstrapComplete || dbBootstrapComplete;

  // Identity files → identityFilesDir + DocumentStore
  for (const file of ['AGENTS.md', 'HEARTBEAT.md']) {
    const dest = join(identityFilesDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
    if (existsSync(src)) {
      const key = `${agentName}/${file}`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(src, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }

  // Config files → agentConfigDir
  for (const file of ['capabilities.yaml']) {
    const dest = join(agentConfigDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
  }

  // BOOTSTRAP.md → both agentConfigDir and identityFilesDir + DocumentStore
  if (!bootstrapAlreadyComplete) {
    const src = join(templatesDir, 'BOOTSTRAP.md');
    if (existsSync(src)) {
      const configDest = join(agentConfigDir, 'BOOTSTRAP.md');
      const identityDest = join(identityFilesDir, 'BOOTSTRAP.md');
      if (!existsSync(configDest)) copyFileSync(src, configDest);
      if (!existsSync(identityDest)) copyFileSync(src, identityDest);
      const key = `${agentName}/BOOTSTRAP.md`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(src, 'utf-8'));
      } catch { /* non-fatal */ }
    }
    const ubSrc = join(templatesDir, 'USER_BOOTSTRAP.md');
    if (existsSync(ubSrc)) {
      const key = `${agentName}/USER_BOOTSTRAP.md`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(ubSrc, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }

  // Skills seeding
  const persistentSkillsDir = agentSkillsDir(agentName);
  mkdirSync(persistentSkillsDir, { recursive: true });
  try {
    const existingSkills = readdirSync(persistentSkillsDir).filter(f => f.endsWith('.md'));
    const existingDirs = readdirSync(persistentSkillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(persistentSkillsDir, d.name, 'SKILL.md')));
    if (existingSkills.length === 0 && existingDirs.length === 0) {
      const seedDir = resolveSeedSkillsDir();
      if (existsSync(seedDir)) {
        const seedEntries = readdirSync(seedDir, { withFileTypes: true });
        for (const entry of seedEntries) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            copyFileSync(join(seedDir, entry.name), join(persistentSkillsDir, entry.name));
          } else if (entry.isDirectory()) {
            cpSync(join(seedDir, entry.name), join(persistentSkillsDir, entry.name), { recursive: true });
          }
        }
      }
    }
  } catch { /* non-fatal */ }

  // Admins file
  const defaultUserId = process.env.USER ?? 'default';
  const adminsPath = join(agentDirVal, 'admins');
  if (!existsSync(adminsPath)) writeFileSync(adminsPath, '', 'utf-8');

  // ── IPC socket ──
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
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
      const skills = await listSkills(providers.storage.documents, agentName);
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
    eventBus,
    workspaceMap,
    requestedCredentials,
    domainList,
    mcpManager,
  };

  // ── Delegation ──
  async function handleDelegate(req: DelegateRequest, ctx: IPCContext): Promise<string> {
    const tier = req.resourceTier ?? 'default';
    const tierConfig = config.sandbox.tiers?.[tier] ?? (tier === 'heavy'
      ? { memory_mb: 2048, cpus: 4 }
      : { memory_mb: config.sandbox.memory_mb, cpus: 1 });

    const childConfig = {
      ...config,
      ...(req.runner ? { agent: req.runner } : {}),
      ...(req.model ? { models: { default: [req.model] } } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      sandbox: {
        ...config.sandbox,
        memory_mb: tierConfig.memory_mb,
        tiers: {
          default: tierConfig,
          heavy: config.sandbox.tiers?.heavy ?? { memory_mb: 2048, cpus: 4 },
        },
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
  await agentRegistry.ensureDefault();

  // ── IPC handler ──
  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentDir: identityFilesDir,
    agentName,
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
    coworkPlugins: mcpManager ? { mcpManager, domainList } : undefined,
  });
  completionDeps.ipcHandler = handleIPC;

  // ── Load MCP servers into the manager from plugins and database ──
  // Database MCP servers and plugin servers are loaded into McpConnectionManager,
  // which provides unified tool discovery and routing via discoverAllTools() and
  // getToolServerUrl(). The legacy providers.mcp path remains as a fallback
  // until the unified manager fully replaces it.
  if (mcpManager && providers.storage?.documents) {
    await reloadPluginMcpServers(providers.storage.documents, mcpManager);
  }
  if (mcpManager && providers.database) {
    await loadDatabaseMcpServers(providers.database, mcpManager);
  }

  const defaultCtx = { sessionId: 'server', agentId: 'system', userId: defaultUserId };
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
    completionDeps,
    handleIPC,
    ipcServer,
    ipcSocketPath,
    ipcSocketDir,
    orchestrator,
    disableAutoState,
    agentRegistry,
    agentName,
    agentDirVal,
    identityFilesDir,
    sessionCanaries,
    workspaceMap,
    requestedCredentials,
    domainList,
    defaultUserId,
    modelId,
    mcpManager,
  };
}
