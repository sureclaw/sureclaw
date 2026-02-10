import { describe, test, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { startAnthropicProxy } from '../../../src/anthropic-proxy.js';

/**
 * Create a minimal mock IPC server that responds to requests with a canned response.
 */
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

describe('claude-code agent', () => {
  let tmpDir: string;
  let ipcServer: Server;
  let proxyResult: { server: import('node:http').Server; stop: () => void };
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    proxyResult?.stop();
    ipcServer?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('createSocketFetch works with ESM dynamic import (no require)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const ipcSocketPath = join(tmpDir, 'ipc.sock');

    // Mock IPC server
    ipcServer = createMockIPCServer(ipcSocketPath, () => ({
      ok: true,
      chunks: [
        { type: 'text', content: 'ESM works!' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 3 } },
      ],
    }));
    await new Promise<void>((r) => ipcServer.on('listening', r));

    // Start proxy
    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    // Import and test createSocketFetch — if require() was used, this would throw
    // ReferenceError: require is not defined
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const socketFetch = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;

    // Verify the custom fetch can reach the proxy at the correct path
    const response = await socketFetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe('message');
  });

  test('Anthropic SDK sends to correct path through unix socket proxy', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const ipcSocketPath = join(tmpDir, 'ipc.sock');

    // Track what path the proxy receives
    let receivedIpcRequest: Record<string, unknown> | null = null;
    ipcServer = createMockIPCServer(ipcSocketPath, (req) => {
      receivedIpcRequest = req;
      return {
        ok: true,
        chunks: [
          { type: 'text', content: 'SDK path test' },
          { type: 'done', usage: { inputTokens: 5, outputTokens: 3 } },
        ],
      };
    });
    await new Promise<void>((r) => ipcServer.on('listening', r));

    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    // Use the Anthropic SDK with baseURL pointing to the proxy — same as claude-code.ts
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const socketFetch = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;

    const anthropic = new Anthropic({
      apiKey: 'ax-proxy',
      // Must NOT include /v1 — the SDK adds /v1 itself
      baseURL: 'http://localhost',
      fetch: socketFetch,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Verify the SDK got a valid response (not 404)
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
    expect((response.content[0] as { type: 'text'; text: string }).text).toBe('SDK path test');

    // Verify IPC call was made
    expect(receivedIpcRequest).not.toBeNull();
    expect(receivedIpcRequest!.action).toBe('llm_call');
  });

  test('runClaudeCode completes a full message cycle', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const workspaceDir = join(tmpDir, 'workspace');
    const skillsDir = join(tmpDir, 'skills');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    // Mock IPC server — responds to llm_call with text (no tools)
    ipcServer = createMockIPCServer(ipcSocketPath, (req) => {
      if (req.action === 'llm_call') {
        return {
          ok: true,
          chunks: [
            { type: 'text', content: 'Hello from claude-code!' },
            { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
          ],
        };
      }
      return { ok: true };
    });
    await new Promise<void>((r) => ipcServer.on('listening', r));

    // Start proxy
    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    // Capture stdout
    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;

    // Suppress stderr (debug logging)
    process.stderr.write = (() => true) as typeof process.stderr.write;

    // Run the agent
    const { runClaudeCode } = await import('../../../src/container/agents/claude-code.js');
    await runClaudeCode({
      agent: 'claude-code',
      ipcSocket: ipcSocketPath,
      proxySocket: proxySocketPath,
      workspace: workspaceDir,
      skills: skillsDir,
      userMessage: 'Say hello',
    });

    expect(stdout).toContain('Hello from claude-code!');
  });

  test('runClaudeCode executes tools and sends results back', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const workspaceDir = join(tmpDir, 'workspace');
    const skillsDir = join(tmpDir, 'skills');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    // Create a file for the agent to read
    writeFileSync(join(workspaceDir, 'test.txt'), 'file content here');

    // Mock IPC: first call returns tool_use, second returns text
    let callCount = 0;
    ipcServer = createMockIPCServer(ipcSocketPath, (req) => {
      if (req.action === 'llm_call') {
        callCount++;
        if (callCount === 1) {
          // First LLM call: ask to read a file
          return {
            ok: true,
            chunks: [
              {
                type: 'tool_use',
                toolCall: { id: 'tc_1', name: 'read_file', args: { path: 'test.txt' } },
              },
              { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
            ],
          };
        }
        // Second LLM call: produce final text
        return {
          ok: true,
          chunks: [
            { type: 'text', content: 'The file says: file content here' },
            { type: 'done', usage: { inputTokens: 20, outputTokens: 10 } },
          ],
        };
      }
      return { ok: true };
    });
    await new Promise<void>((r) => ipcServer.on('listening', r));

    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    const { runClaudeCode } = await import('../../../src/container/agents/claude-code.js');
    await runClaudeCode({
      agent: 'claude-code',
      ipcSocket: ipcSocketPath,
      proxySocket: proxySocketPath,
      workspace: workspaceDir,
      skills: skillsDir,
      userMessage: 'Read test.txt',
    });

    // Agent should have made 2 LLM calls (tool_use + final text)
    expect(callCount).toBe(2);
    expect(stdout).toContain('The file says: file content here');
  });
});
