#!/usr/bin/env npx tsx
/**
 * Test harness — run AX host with nats-subprocess sandbox.
 *
 * Exercises the full k8s code path (NATS IPC, workspace release,
 * work delivery) using local processes for easy debugging.
 *
 * Prerequisites:
 *   1. Local nats-server running: `nats-server`
 *   2. AX built: `npm run build`
 *
 * Usage:
 *   npx tsx tests/providers/sandbox/run-nats-local.ts
 *
 * Debug agent process:
 *   AX_DEBUG_AGENT=1 npx tsx tests/providers/sandbox/run-nats-local.ts
 *   # Then attach Chrome DevTools to the --inspect-brk port
 *
 * Debug host process:
 *   node --inspect -e "import('./tests/providers/sandbox/run-nats-local.ts')"
 */

import { loadConfig } from '../../../src/config.js';
import { createServer } from '../../../src/host/server-local.js';
import { create as createNATSSubprocess } from './nats-subprocess.js';
import { initLogger } from '../../../src/logger.js';

async function main() {
  const port = parseInt(process.env.PORT ?? '8080', 10);

  initLogger({ level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'debug' });

  const config = loadConfig();
  const sandbox = await createNATSSubprocess(config);

  console.log('[run-nats-local] Starting AX with nats-subprocess sandbox...');

  const server = await createServer(config, {
    port,
    providerOverrides: { sandbox },
  });

  await server.start();
  console.log(`[run-nats-local] AX listening on http://localhost:${port}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[run-nats-local] Shutting down...');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[run-nats-local] Fatal:', err);
  process.exit(1);
});
