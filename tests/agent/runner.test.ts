import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';

// We test the run() function with a mock IPC server
import { run } from '../../src/agent/runner.js';

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

describe('buildSystemPrompt', async () => {
  const { buildSystemPrompt } = await import('../../src/agent/runner.js');
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'agent-prompt-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('returns bootstrap content when SOUL.md missing but BOOTSTRAP.md exists', () => {
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap\nDiscover yourself.');
    const prompt = buildSystemPrompt('', [], agentDir);
    expect(prompt).toBe('# Bootstrap\nDiscover yourself.');
  });

  test('uses default instruction when no AGENT.md and no bootstrap', () => {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul content');
    const prompt = buildSystemPrompt('', [], agentDir);
    expect(prompt).toContain('You are AX');
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('# Soul content');
  });

  test('loads AGENT.md as base prompt', () => {
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul');
    writeFileSync(join(agentDir, 'AGENT.md'), '# Custom Agent Rules');
    const prompt = buildSystemPrompt('', [], agentDir);
    expect(prompt).toContain('# Custom Agent Rules');
    expect(prompt).not.toContain('You are AX');
  });

  test('loads all identity files (SOUL, IDENTITY, USER)', () => {
    writeFileSync(join(agentDir, 'SOUL.md'), 'My values');
    writeFileSync(join(agentDir, 'IDENTITY.md'), 'My name is Echo');
    writeFileSync(join(agentDir, 'USER.md'), 'User prefers brevity');
    const prompt = buildSystemPrompt('', [], agentDir);
    expect(prompt).toContain('## Soul');
    expect(prompt).toContain('My values');
    expect(prompt).toContain('## Identity');
    expect(prompt).toContain('My name is Echo');
    expect(prompt).toContain('## User');
    expect(prompt).toContain('User prefers brevity');
  });

  test('includes context and skills alongside identity', () => {
    writeFileSync(join(agentDir, 'SOUL.md'), 'Values');
    const prompt = buildSystemPrompt('Project context here', ['# Skill 1'], agentDir);
    expect(prompt).toContain('## Context');
    expect(prompt).toContain('Project context here');
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('# Skill 1');
  });

  test('bootstrap mode ignores context and skills', () => {
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Bootstrap only');
    const prompt = buildSystemPrompt('context', ['skill'], agentDir);
    expect(prompt).toBe('# Bootstrap only');
    expect(prompt).not.toContain('context');
    expect(prompt).not.toContain('skill');
  });

  test('normal mode when SOUL.md exists even if BOOTSTRAP.md present', () => {
    writeFileSync(join(agentDir, 'SOUL.md'), 'Evolved soul');
    writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '# Should be ignored');
    const prompt = buildSystemPrompt('', [], agentDir);
    expect(prompt).toContain('Evolved soul');
    expect(prompt).not.toContain('Should be ignored');
  });

  test('works without agentDir (backwards compat)', () => {
    const prompt = buildSystemPrompt('ctx', []);
    expect(prompt).toContain('You are AX');
    expect(prompt).toContain('ctx');
  });
});
