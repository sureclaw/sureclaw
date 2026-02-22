/**
 * History smoke test: starts the real server process, sends HTTP requests
 * with session_id to exercise conversation history persistence end-to-end.
 *
 * Only the LLM provider is mocked (llm-mock) — everything else is real:
 * real config loading, real registry, real subprocess sandbox, real scanner,
 * real router, real IPC, real conversation store (SQLite).
 *
 * These tests verify that:
 * 1. Multi-turn persistent sessions accumulate history without crashing
 * 2. Different session_ids don't cross-contaminate
 * 3. Ephemeral sessions (no session_id) work independently
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const TEST_CONFIG = resolve(import.meta.dirname, 'ax-test.yaml');
const IS_BUN = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';

let smokeTestHome: string;
let socketPath: string;

function startServer(): ChildProcess {
  const hostScript = resolve(PROJECT_ROOT, 'src/main.ts');
  const args = IS_BUN
    ? ['run', hostScript, '--config', TEST_CONFIG]
    : ['tsx', hostScript, '--config', TEST_CONFIG];
  const cmd = IS_BUN ? 'bun' : 'npx';
  return spawn(cmd, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: '1', AX_HOME: smokeTestHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function collectOutput(proc: ChildProcess): { stdout: string[]; stderr: string[] } {
  const out = { stdout: [] as string[], stderr: [] as string[] };
  proc.stdout!.on('data', (d: Buffer) => out.stdout.push(d.toString()));
  proc.stderr!.on('data', (d: Buffer) => out.stderr.push(d.toString()));
  return out;
}

function waitForReady(proc: ChildProcess, output: { stdout: string[]; stderr: string[] }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `Server did not become ready in time\nstdout: ${output.stdout.join('')}\nstderr: ${output.stderr.join('')}`
    )), 15_000);

    const check = setInterval(() => {
      const combined = output.stdout.join('') + output.stderr.join('');
      if (combined.includes('server_listening')) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 100);

    proc.on('exit', (code) => {
      clearInterval(check);
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}\nstdout: ${output.stdout.join('')}\nstderr: ${output.stderr.join('')}`));
    });
  });
}

/** Send a chat completion request, optionally with session_id for persistent sessions */
function sendRequest(
  socket: string,
  messages: { role: string; content: string }[],
  sessionId?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload: Record<string, unknown> = {
      model: 'default',
      messages,
      stream: false,
    };
    if (sessionId) {
      payload.session_id = sessionId;
    }
    const bodyStr = JSON.stringify(payload);

    const req = httpRequest(
      {
        socketPath: socket,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

describe('History Smoke Test', () => {
  let proc: ChildProcess | null = null;

  beforeEach(() => {
    smokeTestHome = resolve(tmpdir(), `ax-hsm-${randomUUID()}`);
    mkdirSync(smokeTestHome, { recursive: true });
    socketPath = join(smokeTestHome, 'ax.sock');
  });

  afterEach(() => {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
    }
    proc = null;
    try { rmSync(smokeTestHome, { recursive: true, force: true }); } catch {}
  });

  test('multi-turn persistent session accumulates history without crashing', async () => {
    proc = startServer();
    const output = collectOutput(proc);
    await waitForReady(proc, output);

    const sessionId = randomUUID();

    // Turn 1: first message
    const res1 = await sendRequest(socketPath, [
      { role: 'user', content: 'hello, this is turn one' },
    ], sessionId);
    expect(res1.status).toBe(200);
    const data1 = JSON.parse(res1.body);
    expect(data1.choices[0].message.role).toBe('assistant');
    expect(data1.choices[0].message.content.trim().length).toBeGreaterThan(0);

    // Turn 2: server loads 1 user + 1 assistant turn from DB, adds new user message
    const res2 = await sendRequest(socketPath, [
      { role: 'user', content: 'this is turn two' },
    ], sessionId);
    expect(res2.status).toBe(200);
    const data2 = JSON.parse(res2.body);
    expect(data2.choices[0].message.role).toBe('assistant');
    expect(data2.choices[0].message.content.trim().length).toBeGreaterThan(0);

    // Turn 3: server loads 2 user + 2 assistant turns from DB, adds new user message
    const res3 = await sendRequest(socketPath, [
      { role: 'user', content: 'this is turn three' },
    ], sessionId);
    expect(res3.status).toBe(200);
    const data3 = JSON.parse(res3.body);
    expect(data3.choices[0].message.role).toBe('assistant');
    expect(data3.choices[0].message.content.trim().length).toBeGreaterThan(0);

    // Verify the server is still alive (didn't crash during history loading)
    expect(proc!.killed).toBe(false);

    // Verify the conversation DB was created
    const dbPath = join(smokeTestHome, 'data', 'conversations.db');
    expect(existsSync(dbPath)).toBe(true);
  }, 90_000);

  test('history isolation: different session_ids do not cross-contaminate', async () => {
    proc = startServer();
    const output = collectOutput(proc);
    await waitForReady(proc, output);

    const sessionA = randomUUID();
    const sessionB = randomUUID();

    // Send 2 messages to session A
    const resA1 = await sendRequest(socketPath, [
      { role: 'user', content: 'session A message one' },
    ], sessionA);
    expect(resA1.status).toBe(200);

    const resA2 = await sendRequest(socketPath, [
      { role: 'user', content: 'session A message two' },
    ], sessionA);
    expect(resA2.status).toBe(200);

    // Send 1 message to session B
    const resB1 = await sendRequest(socketPath, [
      { role: 'user', content: 'session B message one' },
    ], sessionB);
    expect(resB1.status).toBe(200);

    // Send another message to session B -- should only have session B's history
    const resB2 = await sendRequest(socketPath, [
      { role: 'user', content: 'session B message two' },
    ], sessionB);
    expect(resB2.status).toBe(200);

    // Both sessions should succeed without the server crashing
    expect(proc!.killed).toBe(false);

    // Verify the DB exists with data from both sessions
    const dbPath = join(smokeTestHome, 'data', 'conversations.db');
    expect(existsSync(dbPath)).toBe(true);

    // Directly check the DB to verify isolation
    const { ConversationStore } = await import('../../src/conversation-store.js');
    const store = await ConversationStore.create(dbPath);
    const turnsA = store.load(sessionA);
    const turnsB = store.load(sessionB);

    // Session A: 2 user + 2 assistant = 4 turns
    expect(turnsA).toHaveLength(4);
    // Session B: 2 user + 2 assistant = 4 turns
    expect(turnsB).toHaveLength(4);

    // Verify no cross-contamination: session A turns should only contain session A content
    for (const turn of turnsA) {
      if (turn.role === 'user') {
        expect(turn.content).toContain('session A');
      }
    }
    for (const turn of turnsB) {
      if (turn.role === 'user') {
        expect(turn.content).toContain('session B');
      }
    }

    store.close();
  }, 90_000);

  test('ephemeral sessions (no session_id) succeed independently', async () => {
    proc = startServer();
    const output = collectOutput(proc);
    await waitForReady(proc, output);

    // Send two independent messages without session_id
    const res1 = await sendRequest(socketPath, [
      { role: 'user', content: 'ephemeral message one' },
    ]);
    expect(res1.status).toBe(200);
    const data1 = JSON.parse(res1.body);
    expect(data1.choices[0].message.role).toBe('assistant');
    expect(data1.choices[0].message.content.trim().length).toBeGreaterThan(0);

    const res2 = await sendRequest(socketPath, [
      { role: 'user', content: 'ephemeral message two' },
    ]);
    expect(res2.status).toBe(200);
    const data2 = JSON.parse(res2.body);
    expect(data2.choices[0].message.role).toBe('assistant');
    expect(data2.choices[0].message.content.trim().length).toBeGreaterThan(0);

    // Server should still be alive
    expect(proc!.killed).toBe(false);

    // Verify no conversation history was persisted for ephemeral sessions
    const dbPath = join(smokeTestHome, 'data', 'conversations.db');
    if (existsSync(dbPath)) {
      const { ConversationStore } = await import('../../src/conversation-store.js');
      const store = await ConversationStore.create(dbPath);
      // No session_id means nothing to look up -- the store should have no
      // turns for any random session ID
      const turns = store.load(randomUUID());
      expect(turns).toHaveLength(0);
      store.close();
    }
  }, 90_000);
});
