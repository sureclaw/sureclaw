/**
 * Tests for pi-coding-agent session runner.
 *
 * Tests both IPC-based (legacy) and proxy-based (new) LLM routing.
 * Starts mock IPC server for non-LLM tools, and a mock HTTP server
 * + real credential-injecting proxy for proxy-mode LLM tests.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startAnthropicProxy } from '../../../src/host/proxy.js';

// We'll dynamically import runPiSession so the test module loads cleanly

function createMockIPCServer(socketPath: string): { server: Server; close: () => void; agentResponses: string[] } {
  const agentResponses: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) break;

        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        buffer = buffer.subarray(4 + msgLen);

        const request = JSON.parse(raw);
        const msgId = request._msgId;
        let response: Record<string, unknown>;

        if (request.action === 'llm_call') {
          // Return a simple mock response
          response = {
            ok: true,
            chunks: [
              { type: 'text', content: 'Hello from mock LLM via IPC.' },
              { type: 'done', usage: { inputTokens: 10, outputTokens: 8 } },
            ],
          };
        } else if (request.action === 'agent_response') {
          agentResponses.push(request.content ?? '');
          response = { ok: true };
        } else {
          response = { ok: true };
        }

        if (msgId) response._msgId = msgId;

        const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(responseBuf.length, 0);
        socket.write(Buffer.concat([lenBuf, responseBuf]));
      }
    });
  });

  server.listen(socketPath);
  return {
    server,
    agentResponses,
    close: () => {
      server.close();
    },
  };
}

/**
 * Create a mock Anthropic API server that returns SSE streaming responses.
 * The Anthropic SDK's .stream() expects SSE events.
 */
function createMockAnthropicApi(
  port: number,
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<HttpServer> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      handler(req, Buffer.concat(chunks).toString(), res);
    });
    server.listen(port, () => resolve(server));
  });
}

/**
 * Build SSE streaming response for a simple text message.
 * Mirrors what the real Anthropic API returns for messages.stream().
 */
function buildSSETextResponse(text: string, opts?: { stop_reason?: string; tool_use?: Array<{ id: string; name: string; input: unknown }> }): string {
  const msgId = `msg_${Date.now()}`;
  const parts: string[] = [];

  // message_start
  parts.push(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', content: [],
      model: 'claude-sonnet-4-5-20250929', stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  })}\n\n`);

  // content_block_start for text
  let blockIdx = 0;
  if (text) {
    parts.push(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start', index: blockIdx,
      content_block: { type: 'text', text: '' },
    })}\n\n`);

    // content_block_delta for text
    parts.push(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta', index: blockIdx,
      delta: { type: 'text_delta', text },
    })}\n\n`);

    // content_block_stop for text
    parts.push(`event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop', index: blockIdx,
    })}\n\n`);

    blockIdx++;
  }

  // tool_use blocks
  if (opts?.tool_use) {
    for (const tool of opts.tool_use) {
      parts.push(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start', index: blockIdx,
        content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
      })}\n\n`);

      const argsJson = JSON.stringify(tool.input);
      parts.push(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta', index: blockIdx,
        delta: { type: 'input_json_delta', partial_json: argsJson },
      })}\n\n`);

      parts.push(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop', index: blockIdx,
      })}\n\n`);

      blockIdx++;
    }
  }

  // message_delta
  const stopReason = opts?.stop_reason ?? 'end_turn';
  parts.push(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  })}\n\n`);

  // message_stop
  parts.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

  return parts.join('');
}

// ── IPC-only tests (no proxy, existing behavior) ────────────────────

describe('pi-session (IPC mode — no proxy)', () => {
  let tempDir: string;
  let workspace: string;
  let skillsDir: string;
  let socketPath: string;
  let mockServer: { server: Server; close: () => void };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ax-pi-session-test-'));
    workspace = join(tempDir, 'workspace');
    skillsDir = join(tempDir, 'skills');
    socketPath = join(tempDir, 'ipc.sock');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    mockServer = createMockIPCServer(socketPath);
    // Signal IPC response mode so agent_response is sent via IPC (not stdout)
    process.env.AX_IPC_LISTEN = '1';
  });

  afterEach(() => {
    mockServer.close();
    delete process.env.AX_IPC_LISTEN;
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('runPiSession completes without error for a simple message (IPC fallback)', async () => {
    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    await runPiSession({
      agent: 'pi-coding-agent',
      ipcSocket: socketPath,
      workspace,
      skills: skillsDir,
      userMessage: 'hello',
      // No proxySocket → should fall back to IPC
    });

    // Response is sent back via agent_response IPC action (not stdout)
    const output = mockServer.agentResponses.join('');
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('Hello from mock LLM via IPC');
  }, 30_000);

  test('runPiSession forwards conversation history to the LLM (IPC)', async () => {
    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    // Track llm_call requests to verify history is forwarded
    const llmCalls: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];

    // Replace mock server with one that records llm_call messages
    mockServer.close();
    socketPath = join(tempDir, 'ipc2.sock');
    const server = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          const msgLen = buffer.readUInt32BE(0);
          if (buffer.length < 4 + msgLen) break;
          const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
          buffer = buffer.subarray(4 + msgLen);
          const request = JSON.parse(raw);
          if (request.action === 'llm_call') {
            llmCalls.push({ messages: request.messages });
          }
          const response = request.action === 'llm_call'
            ? { ok: true, chunks: [{ type: 'text', content: 'ok' }, { type: 'done', usage: { inputTokens: 5, outputTokens: 2 } }] }
            : { ok: true };
          if (request._msgId) response._msgId = request._msgId;
          const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(responseBuf.length, 0);
          socket.write(Buffer.concat([lenBuf, responseBuf]));
        }
      });
    });
    server.listen(socketPath);
    mockServer = { server, close: () => server.close() };

    // Suppress stdout
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await runPiSession({
        agent: 'pi-coding-agent',
        ipcSocket: socketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'what did I ask before?',
        history: [
          { role: 'user' as const, content: 'my favorite color is blue' },
          { role: 'assistant' as const, content: 'Got it, your favorite color is blue.' },
        ],
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    // The LLM should have received at least one call
    expect(llmCalls.length).toBeGreaterThan(0);

    // The messages sent to the LLM should include the history turns
    const firstCall = llmCalls[0];
    const allContent = firstCall.messages.map(m =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    ).join(' ');

    expect(allContent).toContain('my favorite color is blue');
    expect(allContent).toContain('what did I ask before?');
  }, 30_000);

  test('write_file tool creates files in the workspace directory (IPC)', async () => {
    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    // Mock LLM that returns a write_file tool call, then a text response.
    // The write_file tool is now an IPC tool that routes to the host via
    // sandbox_write_file. The mock IPC server simulates the host handler
    // by writing the file to the workspace.
    let callCount = 0;
    mockServer.close();
    socketPath = join(tempDir, 'ipc-write.sock');
    const server = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          const msgLen = buffer.readUInt32BE(0);
          if (buffer.length < 4 + msgLen) break;
          const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
          buffer = buffer.subarray(4 + msgLen);
          const request = JSON.parse(raw);
          let response: Record<string, unknown>;
          if (request.action === 'llm_call') {
            callCount++;
            if (callCount === 1) {
              // First call: tell the agent to write a file via the IPC write_file tool
              response = {
                ok: true,
                chunks: [
                  { type: 'tool_use', toolCall: { id: 'call_1', name: 'write_file', args: { path: 'hello.txt', content: 'hello from tool' } } },
                  { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } },
                ],
              };
            } else {
              // Second call (after tool result): done
              response = {
                ok: true,
                chunks: [
                  { type: 'text', content: 'File written.' },
                  { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
                ],
              };
            }
          } else if (request.action === 'sandbox_write_file') {
            // Simulate the host-side sandbox_write_file handler:
            // write the file to the workspace
            const filePath = join(workspace, request.path);
            const { mkdirSync: mkdirSyncLocal, writeFileSync: writeFileSyncLocal } = require('node:fs');
            const { dirname } = require('node:path');
            mkdirSyncLocal(dirname(filePath), { recursive: true });
            writeFileSyncLocal(filePath, request.content, 'utf-8');
            response = { ok: true, written: true, path: request.path };
          } else {
            response = { ok: true };
          }
          if (request._msgId) response._msgId = request._msgId;
          const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(responseBuf.length, 0);
          socket.write(Buffer.concat([lenBuf, responseBuf]));
        }
      });
    });
    server.listen(socketPath);
    mockServer = { server, close: () => server.close() };

    // Suppress stdout
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await runPiSession({
        agent: 'pi-coding-agent',
        ipcSocket: socketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'create hello.txt',
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    // The file must exist in the workspace (written via IPC sandbox_write_file handler)
    const filePath = join(workspace, 'hello.txt');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('hello from tool');
  }, 30_000);

  test('runPiSession returns immediately for empty message', async () => {
    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    // Should not throw or hang
    await runPiSession({
      agent: 'pi-coding-agent',
      ipcSocket: socketPath,
      workspace,
      skills: skillsDir,
      userMessage: '',
    });
  });

  test('runPiSession returns immediately for whitespace-only message', async () => {
    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    await runPiSession({
      agent: 'pi-coding-agent',
      ipcSocket: socketPath,
      workspace,
      skills: skillsDir,
      userMessage: '   ',
    });
  });
});

// ── Proxy-mode tests (Anthropic SDK via credential-injecting proxy) ──

describe('pi-session (proxy mode — LLM via Anthropic SDK)', () => {
  let tempDir: string;
  let workspace: string;
  let skillsDir: string;
  let ipcSocketPath: string;
  let proxySocketPath: string;
  let mockIPC: { server: Server; close: () => void; agentResponses: string[] };
  let mockApi: HttpServer;
  let proxyResult: { server: HttpServer; stop: () => void };
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let nextPort = 19920;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ax-pi-proxy-test-'));
    workspace = join(tempDir, 'workspace');
    skillsDir = join(tempDir, 'skills');
    ipcSocketPath = join(tempDir, 'ipc.sock');
    proxySocketPath = join(tempDir, 'proxy.sock');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    // Mock IPC server for non-LLM tools (memory, web, audit)
    mockIPC = createMockIPCServer(ipcSocketPath);
    // Signal IPC response mode so agent_response is sent via IPC (not stdout)
    process.env.AX_IPC_LISTEN = '1';
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    delete process.env.AX_IPC_LISTEN;
    mockIPC?.close();
    proxyResult?.stop();
    mockApi?.close();
    delete process.env.ANTHROPIC_API_KEY;
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('Anthropic SDK stream works through proxy (direct SDK test)', async () => {
    const port = nextPort++;

    mockApi = await createMockAnthropicApi(port, (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(buildSSETextResponse('SDK stream works!'));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-sdk';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const socketFetch = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;

    const anthropic = new Anthropic({
      apiKey: 'ax-proxy',
      baseURL: 'http://localhost',
      fetch: socketFetch,
    });

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });

    // Use finalMessage() to get accumulated content (event listeners are unreliable
    // because the SDK may process chunks before we can attach them)
    const finalMsg = await stream.finalMessage();
    expect(finalMsg.content.length).toBeGreaterThan(0);
    expect(finalMsg.content[0].type).toBe('text');
    const textBlock = finalMsg.content[0] as { type: 'text'; text: string };
    expect(textBlock.text).toBe('SDK stream works!');
  }, 30_000);

  test('runPiSession uses proxy for LLM calls when proxySocket is set', async () => {
    const port = nextPort++;

    // Track requests received by the mock Anthropic API
    const receivedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

    mockApi = await createMockAnthropicApi(port, (req, body, res) => {
      receivedRequests.push({ url: req.url!, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(buildSSETextResponse('Hello from mock LLM via proxy!'));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-proxy';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    // Capture stderr for diagnostics
    const stderrChunks: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      await runPiSession({
        agent: 'pi-coding-agent',
        ipcSocket: ipcSocketPath,
        proxySocket: proxySocketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'hello via proxy',
      });
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    const stderrOutput = stderrChunks.join('');

    // Verify the proxy forwarded the request to the Anthropic API
    expect(receivedRequests.length).toBeGreaterThan(0);
    expect(receivedRequests[0].url).toBe('/v1/messages');

    // Verify the request body has standard Anthropic API format
    const reqBody = receivedRequests[0].body;
    expect(reqBody).toHaveProperty('model');
    expect(reqBody).toHaveProperty('max_tokens');
    expect(reqBody).toHaveProperty('messages');
    expect(reqBody).toHaveProperty('stream', true); // SDK .stream() sets this

    // Verify we got LLM text output via agent_response IPC
    const output = mockIPC.agentResponses.join('');
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('Hello from mock LLM via proxy!');
  }, 30_000);

  test('LLM request includes scheduler, identity, and user_write tools', async () => {
    const port = nextPort++;

    // Provide identity with HEARTBEAT.md so scheduler tools are included
    const heartbeatContent = '# Checks\n- check stuff';

    const receivedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

    mockApi = await createMockAnthropicApi(port, (req, body, res) => {
      receivedRequests.push({ url: req.url!, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(buildSSETextResponse('ok'));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-tools-check';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      await runPiSession({
        agent: 'pi-coding-agent',
        ipcSocket: ipcSocketPath,
        proxySocket: proxySocketPath,
        workspace,
        identity: {
          agents: '', soul: '', identity: '', user: '',
          bootstrap: '', userBootstrap: '',
          heartbeat: heartbeatContent,
        },
        userMessage: 'hello',
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    expect(receivedRequests.length).toBeGreaterThan(0);
    const tools = receivedRequests[0].body.tools as Array<{ name: string }>;
    const toolNames = tools.map(t => t.name);

    // Scheduler tool must be present (HEARTBEAT.md exists)
    expect(toolNames).toContain('scheduler');

    // Identity tool must be present (consolidated from identity_write + user_write)
    expect(toolNames).toContain('identity');
  }, 30_000);

  test('proxy stream function handles tool_use responses', async () => {
    const port = nextPort++;

    let callCount = 0;
    mockApi = await createMockAnthropicApi(port, (_req, _body, res) => {
      callCount++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (callCount === 1) {
        // First call: return a tool_use (write_file IPC tool)
        res.end(buildSSETextResponse('', {
          stop_reason: 'tool_use',
          tool_use: [{ id: 'tc_1', name: 'write_file', input: { path: 'proxy-test.txt', content: 'written via proxy' } }],
        }));
      } else {
        // Second call (after tool result): text response
        res.end(buildSSETextResponse('File written via proxy.'));
      }
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-tools';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    // Replace the generic mock IPC server with one that handles sandbox_write_file
    mockIPC.close();
    ipcSocketPath = join(tempDir, 'ipc-proxy-write.sock');
    const server = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          const msgLen = buffer.readUInt32BE(0);
          if (buffer.length < 4 + msgLen) break;
          const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
          buffer = buffer.subarray(4 + msgLen);
          const request = JSON.parse(raw);
          let response: Record<string, unknown>;
          if (request.action === 'llm_call') {
            response = {
              ok: true,
              chunks: [
                { type: 'text', content: 'Hello from mock LLM via IPC.' },
                { type: 'done', usage: { inputTokens: 10, outputTokens: 8 } },
              ],
            };
          } else if (request.action === 'sandbox_write_file') {
            // Simulate the host-side sandbox_write_file handler
            const filePath = join(workspace, request.path);
            const { mkdirSync: mkdirSyncLocal, writeFileSync: writeFileSyncLocal } = require('node:fs');
            const { dirname } = require('node:path');
            mkdirSyncLocal(dirname(filePath), { recursive: true });
            writeFileSyncLocal(filePath, request.content, 'utf-8');
            response = { ok: true, written: true, path: request.path };
          } else {
            response = { ok: true };
          }
          if (request._msgId) response._msgId = request._msgId;
          const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(responseBuf.length, 0);
          socket.write(Buffer.concat([lenBuf, responseBuf]));
        }
      });
    });
    server.listen(ipcSocketPath);
    mockIPC = { server, close: () => server.close() };

    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      await runPiSession({
        agent: 'pi-coding-agent',
        ipcSocket: ipcSocketPath,
        proxySocket: proxySocketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'create proxy-test.txt',
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    // Agent should have made at least 2 LLM calls (tool_use + final)
    expect(callCount).toBeGreaterThanOrEqual(2);

    // The file should exist in the workspace (tool executed via IPC sandbox_write_file)
    const filePath = join(workspace, 'proxy-test.txt');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('written via proxy');
  }, 30_000);

  test('proxy injects real credentials (API key not sent by agent)', async () => {
    const port = nextPort++;

    // Track what headers the mock API receives
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    mockApi = await createMockAnthropicApi(port, (req, _body, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(buildSSETextResponse('Credentials injected.'));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-key-12345';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      await runPiSession({
        agent: 'pi-coding-agent',
        ipcSocket: ipcSocketPath,
        proxySocket: proxySocketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'test credentials',
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    // The proxy should have injected the real API key
    expect(receivedHeaders['x-api-key']).toBe('sk-ant-real-key-12345');
  }, 30_000);

  test('IPC tools still work when LLM is routed through proxy', async () => {
    const port = nextPort++;

    // Track IPC calls from the agent
    const ipcCalls: string[] = [];
    mockIPC.close();
    ipcSocketPath = join(tempDir, 'ipc-track.sock');
    const ipcTracker = createServer((socket: Socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          const msgLen = buffer.readUInt32BE(0);
          if (buffer.length < 4 + msgLen) break;
          const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
          buffer = buffer.subarray(4 + msgLen);
          const request = JSON.parse(raw);
          ipcCalls.push(request.action);
          // Return { ok: true } for everything (IPC for non-LLM tools)
          const response = { ok: true, entries: [], ...(request._msgId ? { _msgId: request._msgId } : {}) };
          const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(responseBuf.length, 0);
          socket.write(Buffer.concat([lenBuf, responseBuf]));
        }
      });
    });
    ipcTracker.listen(ipcSocketPath);
    mockIPC = { server: ipcTracker, close: () => ipcTracker.close() };

    // Mock API: first return memory_query tool call, then text
    let callCount = 0;
    mockApi = await createMockAnthropicApi(port, (_req, _body, res) => {
      callCount++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (callCount === 1) {
        res.end(buildSSETextResponse('', {
          stop_reason: 'tool_use',
          tool_use: [{ id: 'tc_mem', name: 'memory', input: { type: 'query', scope: 'test', query: 'something' } }],
        }));
      } else {
        res.end(buildSSETextResponse('Memory searched.'));
      }
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-ipc';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { runPiSession } = await import('../../../src/agent/runners/pi-session.js');

    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      await runPiSession({
        agent: 'pi-coding-agent',
        ipcSocket: ipcSocketPath,
        proxySocket: proxySocketPath,
        workspace,
        skills: skillsDir,
        userMessage: 'search memory for something',
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    // IPC should have received the memory_query call (not llm_call!)
    expect(ipcCalls).toContain('memory_query');
    // LLM calls should NOT go through IPC when proxy is available
    expect(ipcCalls).not.toContain('llm_call');
  }, 30_000);
});
