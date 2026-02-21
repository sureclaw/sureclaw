import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';

// We test the run() function with a mock IPC server
import { run, parseStdinPayload } from '../../src/agent/runner.js';

function createMockIPCServer(
  socketPath: string,
  handler: (req: Record<string, unknown>) => Record<string, unknown>,
): Server {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) break;
        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        buffer = buffer.subarray(4 + msgLen);
        const request = JSON.parse(raw);
        const response = handler(request);
        const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(responseBuf.length, 0);
        socket.write(Buffer.concat([lenBuf, responseBuf]));
      }
    });
  });
  server.listen(socketPath);
  return server;
}

describe('agent-runner', () => {
  let tmpDir: string;
  let workspace: string;
  let skillsDir: string;
  let socketPath: string;
  let server: Server;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-runner-test-'));
    workspace = join(tmpDir, 'workspace');
    skillsDir = join(tmpDir, 'skills');
    socketPath = join(tmpDir, 'test.sock');
    mkdirSync(workspace);
    mkdirSync(skillsDir);
  });

  afterEach(() => {
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('run() connects to IPC, sends llm_call, and returns response text', async () => {
    server = createMockIPCServer(socketPath, (req) => {
      if (req.action === 'llm_call') {
        return {
          ok: true,
          chunks: [
            { type: 'text', content: 'Hello from mock LLM' },
            { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
          ],
        };
      }
      return { ok: true };
    });
    await new Promise<void>((r) => server.on('listening', r));

    // Capture stdout
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      await run({
        ipcSocket: socketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'Say hello',
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = stdoutChunks.join('');
    expect(output).toContain('Hello from mock LLM');
  });

  test('run() includes conversation history in LLM call', async () => {
    let receivedMessages: any[] = [];
    server = createMockIPCServer(socketPath, (req) => {
      if (req.action === 'llm_call') {
        receivedMessages = (req.messages as any[]) ?? [];
        return {
          ok: true,
          chunks: [
            { type: 'text', content: 'I remember!' },
            { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
          ],
        };
      }
      return { ok: true };
    });
    await new Promise<void>((r) => server.on('listening', r));

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await run({
        ipcSocket: socketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'Do you remember?',
        history: [
          { role: 'user', content: 'My name is Alice' },
          { role: 'assistant', content: 'Nice to meet you, Alice!' },
        ],
      });
    } finally {
      process.stdout.write = origWrite;
    }

    // Should have: system prompt, history (user, assistant), current message (user)
    const nonSystemMsgs = receivedMessages.filter((m: any) => m.role !== 'system');
    expect(nonSystemMsgs.length).toBe(3);
    expect(nonSystemMsgs[0]).toEqual({ role: 'user', content: 'My name is Alice' });
    expect(nonSystemMsgs[1]).toEqual({ role: 'assistant', content: 'Nice to meet you, Alice!' });
    expect(nonSystemMsgs[2]).toEqual({ role: 'user', content: 'Do you remember?' });
  });

  test('run() loads CONTEXT.md into system prompt', async () => {
    writeFileSync(join(workspace, 'CONTEXT.md'), 'Custom context instructions');

    let receivedMessages: any[] = [];
    server = createMockIPCServer(socketPath, (req) => {
      if (req.action === 'llm_call') {
        receivedMessages = (req.messages as any[]) ?? [];
        return {
          ok: true,
          chunks: [
            { type: 'text', content: 'OK' },
            { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
          ],
        };
      }
      return { ok: true };
    });
    await new Promise<void>((r) => server.on('listening', r));

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await run({
        ipcSocket: socketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'Test',
      });
    } finally {
      process.stdout.write = origWrite;
    }

    // System prompt should be the first message with role 'system'
    const systemMsg = receivedMessages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeTruthy();
    expect(systemMsg.content).toContain('Custom context instructions');
  });

  test('run() loads skills from skills directory', async () => {
    writeFileSync(join(skillsDir, 'greeting.md'), '# Greeting Skill\nAlways greet politely.');

    let receivedMessages: any[] = [];
    server = createMockIPCServer(socketPath, (req) => {
      if (req.action === 'llm_call') {
        receivedMessages = (req.messages as any[]) ?? [];
        return {
          ok: true,
          chunks: [
            { type: 'text', content: 'OK' },
            { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
          ],
        };
      }
      return { ok: true };
    });
    await new Promise<void>((r) => server.on('listening', r));

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await run({
        ipcSocket: socketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'Test',
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const systemMsg = receivedMessages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeTruthy();
    expect(systemMsg.content).toContain('Greeting Skill');
  });

  test('run() does nothing for empty message', async () => {
    // Should exit cleanly without connecting to IPC
    await run({
      ipcSocket: socketPath,
      workspace,
      skills: skillsDir,
      userMessage: '   ',
    });
    // If we get here without error, it worked
  });
});

describe('parseStdinPayload with taint state', () => {
  test('extracts taint state from payload', () => {
    const payload = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0.15,
      taintThreshold: 0.10,
      profile: 'paranoid',
      sandboxType: 'nsjail',
    });
    const result = parseStdinPayload(payload);
    expect(result.message).toBe('hello');
    expect(result.taintRatio).toBe(0.15);
    expect(result.taintThreshold).toBe(0.10);
    expect(result.profile).toBe('paranoid');
    expect(result.sandboxType).toBe('nsjail');
  });

  test('defaults taint state when absent (backward compat)', () => {
    const payload = JSON.stringify({ message: 'hello', history: [] });
    const result = parseStdinPayload(payload);
    expect(result.taintRatio).toBe(0);
    expect(result.taintThreshold).toBe(1); // permissive default
    expect(result.profile).toBe('balanced');
    expect(result.sandboxType).toBe('subprocess');
  });

  test('plain text falls back gracefully', () => {
    const result = parseStdinPayload('just text');
    expect(result.message).toBe('just text');
    expect(result.taintRatio).toBe(0);
  });

  test('extracts replyOptional when true', () => {
    const payload = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0,
      taintThreshold: 0.3,
      profile: 'balanced',
      sandboxType: 'subprocess',
      replyOptional: true,
    });
    const result = parseStdinPayload(payload);
    expect(result.replyOptional).toBe(true);
  });

  test('defaults replyOptional to false when absent', () => {
    const payload = JSON.stringify({
      message: 'hello',
      history: [],
      taintRatio: 0,
      taintThreshold: 0.3,
      profile: 'balanced',
      sandboxType: 'subprocess',
    });
    const result = parseStdinPayload(payload);
    expect(result.replyOptional).toBe(false);
  });
});

// buildSystemPrompt tests removed — behavior is now covered by
// tests/agent/prompt/modules/identity.test.ts (and other module tests)
