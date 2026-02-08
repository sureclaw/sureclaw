import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { loadProviders } from './registry.js';
import { MessageQueue } from './db.js';
import { createRouter } from './router.js';
import { createIPCHandler, createIPCServer } from './ipc.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import type { InboundMessage } from './providers/types.js';

// ═══════════════════════════════════════════════════════
// CLI Args
// ═══════════════════════════════════════════════════════

function parseHostArgs(): { configPath?: string } {
  const args = process.argv.slice(2);
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      configPath = args[++i];
    }
  }

  return { configPath };
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main(): Promise<void> {
  const { configPath } = parseHostArgs();

  // Step 1: Load config
  console.log('[host] Loading config...');
  const config = loadConfig(configPath);
  console.log(`[host] Profile: ${config.profile}`);

  // Step 2: Load providers
  console.log('[host] Loading providers...');
  const providers = await loadProviders(config);
  console.log('[host] Providers loaded');

  // Step 3: Initialize DB + Taint Budget + Router + IPC
  mkdirSync('data', { recursive: true });
  const db = new MessageQueue('data/messages.db');
  const taintBudget = new TaintBudget({
    threshold: thresholdForProfile(config.profile),
  });
  const router = createRouter(providers, db, { taintBudget });
  const handleIPC = createIPCHandler(providers, { taintBudget });

  // Step 4: IPC socket server
  const socketDir = mkdtempSync(join(tmpdir(), 'sureclaw-'));
  const socketPath = join(socketDir, 'proxy.sock');
  const defaultCtx = { sessionId: 'host', agentId: 'system' };
  const ipcServer = createIPCServer(socketPath, handleIPC, defaultCtx);
  console.log(`[host] IPC server listening on ${socketPath}`);

  // Step 5: Session tracking for canary tokens
  const sessionCanaries = new Map<string, string>();

  // Step 6: Message handler (shared by channels and scheduler)
  async function handleMessage(msg: InboundMessage): Promise<void> {
    const result = await router.processInbound(msg);

    if (!result.queued) {
      console.log(`[host] Message blocked: ${result.scanResult.reason ?? 'scan failed'}`);
      // Notify the channel that sent the message
      for (const ch of providers.channels) {
        if (ch.name === msg.channel) {
          await ch.send(msg.sender, {
            content: `Message blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
          });
        }
      }
      return;
    }

    // Track canary token for this session
    sessionCanaries.set(result.sessionId, result.canaryToken);

    // Process the queued message
    await processNextMessage();
  }

  // Step 7: Main processing loop
  async function processNextMessage(): Promise<void> {
    const queued = db.dequeue();
    if (!queued) return;

    let workspace = '';
    try {
      // Create temporary workspace
      workspace = mkdtempSync(join(tmpdir(), 'sureclaw-ws-'));
      const skillsDir = resolve('skills');

      // Write the message content to workspace for the agent
      writeFileSync(join(workspace, 'CONTEXT.md'), `# Session: ${queued.session_id}\n`);
      writeFileSync(join(workspace, 'message.txt'), queued.content);

      // Spawn sandbox — use tsx to run TypeScript directly
      const proc = await providers.sandbox.spawn({
        workspace,
        skills: skillsDir,
        ipcSocket: socketPath,
        timeoutSec: config.sandbox.timeout_sec,
        memoryMB: config.sandbox.memory_mb,
        command: ['npx', 'tsx', resolve('src/container/agent-runner.ts'),
          '--ipc-socket', socketPath,
          '--workspace', workspace,
          '--skills', skillsDir,
        ],
      });

      // Pipe message content to agent's stdin
      proc.stdin.write(queued.content);
      proc.stdin.end();

      // Collect stdout
      let response = '';
      for await (const chunk of proc.stdout) {
        response += chunk.toString();
      }

      // Collect stderr for logging
      let stderr = '';
      for await (const chunk of proc.stderr) {
        stderr += chunk.toString();
      }

      const exitCode = await proc.exitCode;

      if (stderr) {
        console.error(`[host] Agent stderr: ${stderr.slice(0, 500)}`);
      }

      if (exitCode !== 0) {
        console.error(`[host] Agent exited with code ${exitCode}`);
        db.fail(queued.id);
        return;
      }

      // Process outbound through router
      const canaryToken = sessionCanaries.get(queued.session_id) ?? '';
      const outbound = await router.processOutbound(response, queued.session_id, canaryToken);

      if (outbound.canaryLeaked) {
        console.error('[host] SECURITY: Canary token leaked — response redacted');
      }

      // Send response back through the originating channel
      for (const ch of providers.channels) {
        if (ch.name === queued.channel) {
          await ch.send(queued.sender, { content: outbound.content });
        }
      }

      db.complete(queued.id);
      sessionCanaries.delete(queued.session_id);

    } catch (err) {
      console.error(`[host] Processing error: ${err}`);
      db.fail(queued.id);
    } finally {
      // Clean up workspace
      if (workspace) {
        try { rmSync(workspace, { recursive: true, force: true }); } catch {}
      }
    }
  }

  // Step 8: Start scheduler (before channels so it's ready)
  await providers.scheduler.start(handleMessage);

  // Step 9: Graceful shutdown
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[host] Received ${signal}, shutting down...`);

    await providers.scheduler.stop();

    for (const channel of providers.channels) {
      await channel.disconnect();
    }

    ipcServer.close();
    db.close();

    // Clean up socket
    try { rmSync(socketDir, { recursive: true, force: true }); } catch {}

    console.log('[host] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Step 10: Print ready message, THEN connect channels (so prompt appears last)
  console.log('[host] SureClaw is running.');

  for (const channel of providers.channels) {
    channel.onMessage(handleMessage);
    await channel.connect();
  }
}

main().catch((err) => {
  console.error(`[host] Fatal error: ${err}`);
  process.exit(1);
});
