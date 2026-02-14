// src/cli/index.ts
import { existsSync } from 'node:fs';
import { configPath as getConfigPath, axHome } from '../paths.js';
import { loadDotEnv } from '../dotenv.js';

// ═══════════════════════════════════════════════════════
// Command Router (also used by tests)
// ═══════════════════════════════════════════════════════

export interface CommandHandlers {
  serve?: () => Promise<void>;
  chat?: () => Promise<void>;
  send?: (args: string[]) => Promise<void>;
  configure?: () => Promise<void>;
  bootstrap?: (args: string[]) => Promise<void>;
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
    case 'chat':
      if (handlers.chat) await handlers.chat();
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
  ax chat [options]      Start interactive chat client
  ax send <message>      Send a single message
  ax configure           Run configuration wizard
  ax bootstrap [agent]   Reset agent identity and re-run bootstrap

Server Options:
  --daemon               Run server in background
  --socket <path>        Unix socket path (default: ~/.ax/ax.sock)
  --config <path>        Config file path (default: ~/.ax/ax.yaml)
  --verbose              Show tool calls and LLM turns in real-time

Chat Options:
  --socket <path>        Unix socket path (default: ~/.ax/ax.sock)
  --no-stream            Disable streaming responses

Send Options:
  --socket <path>        Unix socket path (default: ~/.ax/ax.sock)
  --stdin, -             Read message from stdin
  --no-stream            Wait for full response
  --json                 Output full OpenAI JSON response

Examples:
  ax serve --daemon
  ax chat
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

  const knownCommands = new Set(['serve', 'chat', 'send', 'configure', 'bootstrap', 'help']);
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
    chat: async () => {
      const { runChat } = await import('./chat.js');
      await runChat(restArgs);
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
    help: async () => {
      showHelp();
    },
  });
}

async function runServe(args: string[]): Promise<void> {
  let configPath: string | undefined;
  let daemon = false;
  let socketPath: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      configPath = args[++i];
    } else if (args[i] === '--daemon') {
      daemon = true;
    } else if (args[i] === '--socket') {
      socketPath = args[++i];
    } else if (args[i] === '--verbose') {
      verbose = true;
    }
  }

  // First-run detection
  const resolvedConfigPath = configPath ?? getConfigPath();
  if (!existsSync(resolvedConfigPath)) {
    console.log('[server] No ax.yaml found — running first-time setup...\n');
    const { runConfigure } = await import('../onboarding/configure.js');
    await runConfigure(axHome());
    await loadDotEnv();
    console.log('[server] Setup complete! Starting AX...\n');
  }

  // Load config and create server
  const { loadConfig } = await import('../config.js');
  const { createServer } = await import('../host/server.js');

  console.log('[server] Loading config...');
  const config = loadConfig(configPath);
  console.log(`[server] Profile: ${config.profile}`);

  const server = await createServer(config, { socketPath, daemon, verbose });
  await server.start();

  if (daemon) {
    console.log('[server] Running in daemon mode');
    process.disconnect?.();
  }
}

// Run if called directly
const scriptUrl = `file://${process.argv[1]}`;
if (import.meta.url === scriptUrl) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
