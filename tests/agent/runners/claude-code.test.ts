import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { PromptBuilder } from '../../../src/agent/prompt/builder.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startAnthropicProxy } from '../../../src/host/proxy.js';

/**
 * Create a mock Anthropic API server that returns canned responses.
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

function anthropicJsonResponse(content: Array<{ type: string; text?: string }>) {
  return JSON.stringify({
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

describe('claude-code proxy infrastructure', () => {
  let tmpDir: string;
  let mockApi: HttpServer;
  let proxyResult: { server: HttpServer; stop: () => void };
  let nextPort = 19910;

  afterEach(() => {
    proxyResult?.stop();
    mockApi?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('undici dispatcher routes through Unix socket proxy (ESM import)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const port = nextPort++;

    mockApi = await createMockAnthropicApi(port, (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(anthropicJsonResponse([{ type: 'text', text: 'ESM works!' }]));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });

    const response = await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe('message');
  });

  test('Anthropic SDK sends to correct path through Unix socket proxy', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const port = nextPort++;

    let receivedUrl: string | undefined;
    mockApi = await createMockAnthropicApi(port, (req, _body, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(anthropicJsonResponse([{ type: 'text', text: 'SDK path test' }]));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const socketFetch = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;

    const anthropic = new Anthropic({
      apiKey: 'ax-proxy',
      baseURL: 'http://localhost',
      fetch: socketFetch,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
    expect((response.content[0] as { type: 'text'; text: string }).text).toBe('SDK path test');
    expect(receivedUrl).toBe('/v1/messages');
  });
});

describe('claude-code identity file loading', () => {
  let agentDir: string;

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  });

  test('system prompt includes identity files from agentDir', async () => {
    // Regression: claude-code runner previously hardcoded empty identity files,
    // so SOUL.md/IDENTITY.md written by identity_write were never loaded.
    agentDir = mkdtempSync(join(tmpdir(), 'cc-identity-'));
    writeFileSync(join(agentDir, 'SOUL.md'), '# Soul\nI am curious and kind.');
    writeFileSync(join(agentDir, 'IDENTITY.md'), '# Identity\n**Name**: Connie');

    // Load identity the same way claude-code.ts does
    const { readFileSync } = await import('node:fs');
    function loadIdentityFile(dir: string, filename: string): string {
      try { return readFileSync(join(dir, filename), 'utf-8'); } catch { return ''; }
    }
    const identityFiles = {
      agents: loadIdentityFile(agentDir, 'AGENTS.md'),
      soul: loadIdentityFile(agentDir, 'SOUL.md'),
      identity: loadIdentityFile(agentDir, 'IDENTITY.md'),
      user: loadIdentityFile(agentDir, 'USER.md'),
      bootstrap: loadIdentityFile(agentDir, 'BOOTSTRAP.md'),
      userBootstrap: '',
    };

    const builder = new PromptBuilder();
    const result = builder.build({
      agentType: 'claude-code',
      workspace: '/tmp',
      skills: [],
      profile: 'balanced',
      sandboxType: 'subprocess',
      taintRatio: 0,
      taintThreshold: 1,
      identityFiles,
      contextContent: '',
      contextWindow: 200000,
      historyTokens: 0,
    });

    expect(result.content).toContain('I am curious and kind');
    expect(result.content).toContain('Connie');
  });

  test('system prompt falls back to default when agentDir has no identity files', async () => {
    agentDir = mkdtempSync(join(tmpdir(), 'cc-identity-empty-'));

    const identityFiles = { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '' };

    const builder = new PromptBuilder();
    const result = builder.build({
      agentType: 'claude-code',
      workspace: '/tmp',
      skills: [],
      profile: 'balanced',
      sandboxType: 'subprocess',
      taintRatio: 0,
      taintThreshold: 1,
      identityFiles,
      contextContent: '',
      contextWindow: 200000,
      historyTokens: 0,
    });

    // Falls back to default identity
    expect(result.content).toContain('You are AX');
    expect(result.content).not.toContain('Connie');
  });
});
