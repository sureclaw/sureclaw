import { resolveProviderPath, listPluginProviders } from './provider-map.js';
import type { Config, ProviderRegistry } from '../types.js';
import type { DatabaseProvider } from '../providers/database/types.js';
import { isTracingEnabled, getTracer } from '../utils/tracing.js';
import { TracedLLMProvider } from '../providers/llm/traced.js';
import type { PluginHost } from './plugin-host.js';

export interface LoadProvidersOptions {
  /** Optional PluginHost for loading third-party plugin providers (Phase 3). */
  pluginHost?: PluginHost;
  /** Override specific providers after loading (test/debug only). */
  providerOverrides?: Partial<ProviderRegistry>;
}

export async function loadProviders(config: Config, opts?: LoadProvidersOptions): Promise<ProviderRegistry> {
  // Phase 3: If a PluginHost is provided, start it so plugin-provided
  // providers are registered in the provider map before we load them.
  if (opts?.pluginHost) {
    await opts.pluginHost.startAll();
  }

  // When using database credentials, we need the DB connection first.
  // For other credential providers (plaintext, keychain), keep original order.
  let database: DatabaseProvider | undefined;
  const needsDbForCreds = config.providers.credentials === 'database';

  if (needsDbForCreds && config.providers.database) {
    const dbModPath = resolveProviderPath('database', config.providers.database);
    const dbMod = await import(dbModPath);
    database = await dbMod.create(config);
  }

  // Load credential provider and seed process.env.
  // Other providers (e.g. Slack) read tokens from process.env at creation
  // time, so credentials must be available before they are loaded.
  let credentials;
  if (needsDbForCreds) {
    const credModPath = resolveProviderPath('credentials', 'database');
    const credMod = await import(credModPath);
    credentials = await credMod.create(config, 'database', { database });
  } else {
    credentials = await loadProvider('credentials', config.providers.credentials, config);
  }
  const { loadCredentials } = await import('../dotenv.js');
  await loadCredentials(credentials);

  // Load database provider if not already loaded above for credential provider.
  if (!database && config.providers.database) {
    const dbModPath = resolveProviderPath('database', config.providers.database);
    const dbMod = await import(dbModPath);
    database = await dbMod.create(config);
  }

  // Filter out 'cli' — the CLI channel was replaced by the ax chat/send clients.
  // Old configs may still list it; silently skip for backward compatibility.
  const channelNames = config.providers.channels.filter(name => (name as string) !== 'cli');
  const channels = await Promise.all(
    channelNames.map(name => loadProvider('channel', name, config))
  );

  // For claude-code agents, LLM calls go through the credential-injecting proxy,
  // not through IPC. Load 'anthropic' as a stub so the server can report a model
  // name. For all other agents, always use the LLM router — it parses compound
  // provider/model IDs from config.models.
  const llmProviderName = config.agent === 'claude-code'
    ? 'anthropic'
    : 'router';

  const llm = await loadProvider('llm', llmProviderName, config);
  const tracedLlm = isTracingEnabled()
    ? new TracedLLMProvider(llm, getTracer())
    : llm;

  // Load image router only when models.image is configured.
  const image = config.models?.image?.length
    ? await loadProvider('image', 'router', config)
    : undefined;

  // Load storage provider BEFORE skills — skills provider needs DocumentStore
  const storageModPath = resolveProviderPath('storage', config.providers.storage);
  const storageMod = await import(storageModPath);
  const storage = await storageMod.create(config, config.providers.storage, { database });

  // Load screener for workspace release screening
  const screener = config.providers.screener
    ? await loadProvider('screener', config.providers.screener, config)
    : undefined;

  // Load eventbus provider BEFORE memory and scheduler — both consume it.
  const eventbus = await loadProvider('eventbus', config.providers.eventbus, config);

  // Load memory provider, passing LLM for extraction + summary generation + database + eventbus
  const memoryModPath = resolveProviderPath('memory', config.providers.memory);
  const memoryMod = await import(memoryModPath);
  const memory = await memoryMod.create(config, config.providers.memory, { llm: tracedLlm, database, eventbus });

  // Load audit provider — pass database for audit/database provider
  const auditModPath = resolveProviderPath('audit', config.providers.audit);
  const auditMod = await import(auditModPath);
  const audit = await auditMod.create(config, config.providers.audit, { database });

  // Load workspace provider with skill screening hook (default: none = no-op stub)
  const { createCommitScreener } = await import('./workspace-release-screener.js');
  const wsModPath = resolveProviderPath('workspace', config.providers.workspace);
  const wsMod = await import(wsModPath);
  const workspace = await wsMod.create(config, config.providers.workspace, {
    screenCommit: createCommitScreener(screener, audit),
  });

  // Load MCP provider if configured (optional — fast path only).
  // NOTE: providers.mcp is deprecated. New MCP servers should be added via:
  // 1. Database: `ax mcp add` / admin dashboard (loaded into McpConnectionManager at startup)
  // 2. Cowork plugins: `ax plugin install` (loaded into McpConnectionManager on install)
  // The database MCP provider remains as a legacy option until all callers
  // migrate to the unified McpConnectionManager routing path.
  let mcp;
  if (config.providers.mcp === 'database') {
    if (!database) {
      throw new Error('providers.mcp=database requires providers.database to be configured');
    }
    const mcpModPath = resolveProviderPath('mcp', 'database');
    const mcpMod = await import(mcpModPath);
    mcp = await mcpMod.create(config, 'database', { database, credentials });
  } else if (config.providers.mcp) {
    mcp = await loadProvider('mcp', config.providers.mcp, config);
  }

  const registry: ProviderRegistry = {
    llm:         tracedLlm,
    image,
    memory,
    scanner:     await loadScanner(config, tracedLlm),
    channels,
    webFetch:   await (await import('../providers/web/fetch.js')).create(config),
    webExtract: await loadProvider('web_extract', config.providers.web.extract, config),
    webSearch:  await loadProvider('web_search', config.providers.web.search, config),
    browser:     await loadProvider('browser', config.providers.browser, config),
    credentials,
    audit,
    sandbox:     await loadProvider('sandbox', config.providers.sandbox, config),
    scheduler:   await loadScheduler(config, database, eventbus),
    storage,
    database,
    eventbus,
    workspace,
    mcp,
    screener,
  };

  if (opts?.providerOverrides) {
    Object.assign(registry, opts.providerOverrides);
  }

  return registry;
}

async function loadProvider(kind: string, name: string, config: Config) {
  const modulePath = resolveProviderPath(kind, name);
  const mod = await import(modulePath);

  if (typeof mod.create !== 'function') {
    throw new Error(
      `Provider ${kind}/${name} (${modulePath}) does not export a create() function`
    );
  }

  return mod.create(config, name);
}

async function loadScanner(config: Config, llm: import('../providers/llm/types.js').LLMProvider) {
  const scannerModPath = resolveProviderPath('scanner', config.providers.scanner);
  const scannerMod = await import(scannerModPath);
  return scannerMod.create(config, config.providers.scanner, { llm });
}

async function loadScheduler(config: Config, database?: DatabaseProvider, eventbus?: import('../providers/eventbus/types.js').EventBusProvider) {
  const modulePath = resolveProviderPath('scheduler', config.providers.scheduler);
  const mod = await import(modulePath);
  return mod.create(config, { database, eventbus });
}
