// src/cli/index.ts
import { existsSync } from 'node:fs';
import { configPath as getConfigPath, axHome } from '../paths.js';
import { loadDotEnv } from '../dotenv.js';
import type { LogLevel } from '../logger.js';

// ═══════════════════════════════════════════════════════
// Command Router (also used by tests)
// ═══════════════════════════════════════════════════════

export interface CommandHandlers {
  serve?: () => Promise<void>;
  send?: (args: string[]) => Promise<void>;
  configure?: () => Promise<void>;
  bootstrap?: (args: string[]) => Promise<void>;
  plugin?: (args: string[]) => Promise<void>;
  provider?: (args: string[]) => Promise<void>;
  k8s?: (args: string[]) => Promise<void>;
  mcp?: (args: string[]) => Promise<void>;
  help?: () => Promise<void>;
}

export async function routeCommand(
  args: string[],
  handlers: CommandHandlers,
): Promise<void> {
  const command = args[0] || 'serve';

  switch (command) {
    case 'serve':
      if (handlers.serve) await handlers.serve();
      break;
    case 'send':
      if (handlers.send) await handlers.send(args.slice(1));
      break;
    case 'configure':
      if (handlers.configure) await handlers.configure();
      break;
    case 'bootstrap':
      if (handlers.bootstrap) await handlers.bootstrap(args.slice(1));
      break;
    case 'plugin':
      if (handlers.plugin) await handlers.plugin(args.slice(1));
      break;
    case 'provider':
      if (handlers.provider) await handlers.provider(args.slice(1));
      break;
    case 'k8s':
      if (handlers.k8s) await handlers.k8s(args.slice(1));
      break;
    case 'mcp':
      if (handlers.mcp) await handlers.mcp(args.slice(1));
      break;
    default:
      if (handlers.help) await handlers.help();
      break;
  }
}

export function showHelp(): void {
  console.log(`
AX - Security-first personal AI agent

Usage:
  ax serve [options]     Start the AX server (default)
  ax send <message>      Send a single message
  ax configure           Run configuration wizard
  ax bootstrap [agent]   Reset agent identity and re-run bootstrap
  ax plugin <command>    Manage Cowork plugins (install/remove/list)
  ax provider <command>  Manage third-party provider plugins (add/remove/list/verify)
  ax mcp <command>       Manage MCP server connections (add/remove/list/test)
  ax k8s init [options]  Generate Helm values and K8s secrets for deployment

Server Options:
  --daemon               Run server in background
  --socket <path>        Unix socket path (default: ~/.ax/ax.sock)
  --port <number>        Also listen on a TCP port (for external clients)
  --config <path>        Config file path (default: ~/.ax/ax.yaml)
  --verbose              Show tool calls and LLM turns in real-time
  --json                 Output all logs and events as JSONL

Send Options:
  --socket <path>        Unix socket path (default: ~/.ax/ax.sock)
  --stdin, -             Read message from stdin
  --no-stream            Wait for full response
  --json                 Output full OpenAI JSON response

Admin Dashboard:
  The admin dashboard URL (with token) is printed when the server starts.
  Just click the URL to open the dashboard — no separate login needed.

Examples:
  ax serve --daemon
  ax send "what is the capital of France"
  echo "summarize this" | ax send --stdin
  `);
}

// ═══════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════

export async function main(): Promise<void> {
  await loadDotEnv();

  const rawArgs = process.argv.slice(2);

  // Extract command: first arg that matches a known command.
  // Flags like --config before the command should not be treated as commands.
  // Handle global flags before command routing
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    showHelp();
    return;
  }

  if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json');
    console.log(`ax ${pkg.version}`);
    return;
  }

  const knownCommands = new Set(['serve', 'send', 'configure', 'bootstrap', 'plugin', 'provider', 'k8s', 'mcp', 'help']);
  let command: string;
  let restArgs: string[];

  if (rawArgs.length > 0 && knownCommands.has(rawArgs[0])) {
    command = rawArgs[0];
    restArgs = rawArgs.slice(1);
  } else {
    command = 'serve';
    restArgs = rawArgs;
  }

  // routeCommand expects the command as args[0]
  await routeCommand([command, ...restArgs], {
    serve: async () => {
      await runServe(restArgs);
    },
    send: async (sendArgs) => {
      const { runSend } = await import('./send.js');
      await runSend(sendArgs);
    },
    configure: async () => {
      const { runConfigure } = await import('../onboarding/configure.js');
      await runConfigure(axHome());
    },
    bootstrap: async (bootstrapArgs) => {
      const { runBootstrap } = await import('./bootstrap.js');
      await runBootstrap(bootstrapArgs);
    },
    plugin: async (pluginArgs) => {
      const { runPlugin } = await import('./plugin.js');
      await runPlugin(pluginArgs);
    },
    provider: async (providerArgs) => {
      const { runProvider } = await import('./provider.js');
      await runProvider(providerArgs);
    },
    mcp: async (mcpArgs) => {
      const { runMcp } = await import('./mcp.js');
      await runMcp(mcpArgs);
    },
    k8s: async (k8sArgs) => {
      const subcommand = k8sArgs[0];
      if (subcommand === 'init') {
        const { runK8sInit } = await import('./k8s-init.js');
        await runK8sInit(k8sArgs.slice(1));
      } else {
        console.error(`Unknown k8s subcommand: ${subcommand ?? '(none)'}`);
        console.error('Usage: ax k8s init [options]');
        process.exit(1);
      }
    },
    help: async () => {
      showHelp();
    },
  });
}

async function runServe(args: string[]): Promise<void> {
  let configPath: string | undefined;
  let daemon = false;
  let socketPath: string | undefined;
  let port: number | undefined;
  let verbose = process.env.AX_VERBOSE === '1';
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      configPath = args[++i];
    } else if (args[i] === '--daemon') {
      daemon = true;
    } else if (args[i] === '--socket') {
      socketPath = args[++i];
    } else if (args[i] === '--port' || args[i] === '-p') {
      const raw = args[++i];
      port = parseInt(raw, 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${raw}`);
        process.exit(1);
      }
    } else if (args[i] === '--verbose') {
      verbose = true;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    }
  }

  // Initialize logger before anything else
  const { initLogger } = await import('../logger.js');
  const isTTY = process.stdout.isTTY ?? false;
  const usePretty = isTTY && !jsonOutput;
  const defaultLevel = (usePretty && !verbose) ? 'warn' : (verbose ? 'debug' : 'info');
  const logger = initLogger({
    level: (process.env.LOG_LEVEL as LogLevel) ?? defaultLevel,
    pretty: usePretty,
    file: true,
  });

  // First-run detection: if no config file, start setup wizard
  const resolvedConfigPath = configPath ?? getConfigPath();
  if (!existsSync(resolvedConfigPath)) {
    logger.info('first_run', { message: 'No ax.yaml found — launching setup wizard...' });
    const { runSetupServer } = await import('./setup-server.js');
    await runSetupServer({ port: port ?? 8080, configPath: resolvedConfigPath });
    await loadDotEnv();
    logger.info('setup_complete', { message: 'Setup complete! Starting AX...' });
  }

  // Load config and create server
  const { loadConfig } = await import('../config.js');
  const { createServer } = await import('../host/server-local.js');

  logger.debug('loading_config');
  let config = loadConfig(configPath);
  logger.debug('config_loaded', { profile: config.profile });

  const serverOpts = { socketPath, port, daemon, verbose, json: jsonOutput };
  let server = await createServer(config, serverOpts);
  await server.start();

  // Set up hot reload on config changes
  const { setupConfigReload } = await import('./reload.js');
  const reloadHandle = setupConfigReload({
    getServer: () => server,
    setServer: (s) => { server = s; },
    loadConfig: () => loadConfig(configPath),
    createServer: (cfg) => createServer(cfg, serverOpts),
    logger,
    configPath: resolvedConfigPath,
  });

  // Graceful shutdown on Ctrl+C / kill
  let stopping = false;
  const cleanupAndExit = async () => {
    if (stopping) return;
    stopping = true;
    reloadHandle.cleanup();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);

  if (daemon) {
    logger.info('daemon_mode');
    process.disconnect?.();
  }
}

// Run if called directly
const scriptUrl = `file://${process.argv[1]}`;
if (import.meta.url === scriptUrl) {
  main().catch(async (err) => {
    const { diagnoseError, formatDiagnosedError } = await import('../errors.js');
    const diagnosed = diagnoseError(err as Error);
    console.error(formatDiagnosedError(diagnosed));
    // Setting exitCode and letting the event loop drain naturally avoids
    // the "sonic boom is not ready yet" crash that happens when
    // process.exit() fires pino's flush handler before the log file
    // stream has opened.
    process.exitCode = 1;
  });
}
