import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { PromptBuilder } from '../../../src/agent/prompt/builder.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startAnthropicProxy } from '../../../src/host/proxy.js';
import { buildSDKPrompt } from '../../../src/agent/runners/claude-code.js';
import type { ContentBlock } from '../../../src/types.js';

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
    // so SOUL.md/IDENTITY.md from the workspace were never loaded.
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
      heartbeat: '',
    };

    const builder = new PromptBuilder();
    const result = builder.build({
      agentType: 'claude-code',
      workspace: '/tmp',
      skills: [],
      profile: 'balanced',
      sandboxType: 'docker',
      taintRatio: 0,
      taintThreshold: 1,
      identityFiles,

      contextWindow: 200000,
      historyTokens: 0,
    });

    expect(result.content).toContain('I am curious and kind');
    expect(result.content).toContain('Connie');
  });

  test('system prompt enters bootstrap mode when agentDir has no identity files', async () => {
    agentDir = mkdtempSync(join(tmpdir(), 'cc-identity-empty-'));

    const identityFiles = { agents: '', soul: '', identity: '', bootstrap: '', userBootstrap: '', heartbeat: '' };

    const builder = new PromptBuilder();
    const result = builder.build({
      agentType: 'claude-code',
      workspace: '/tmp',
      skills: [],
      profile: 'balanced',
      sandboxType: 'docker',
      taintRatio: 0,
      taintThreshold: 1,
      identityFiles,

      contextWindow: 200000,
      historyTokens: 0,
    });

    // No soul/identity = bootstrap mode; normal mode content is excluded
    expect(result.content).not.toContain('Connie');
    expect(result.content).not.toContain('Security Boundaries');
    expect(result.content).not.toContain('Injection Defense');
  });
});

describe('buildSDKPrompt', () => {
  test('returns plain string when no image blocks', () => {
    const result = buildSDKPrompt('hello world', []);
    expect(result).toBe('hello world');
  });

  test('returns AsyncIterable with text and image blocks when images present', async () => {
    const imageBlocks: ContentBlock[] = [
      { type: 'image_data', data: 'aGVsbG8=', mimeType: 'image/png' },
    ];

    const result = buildSDKPrompt('describe this image', imageBlocks);

    // Should be an AsyncIterable, not a string
    expect(typeof result).not.toBe('string');
    const iter = result as AsyncIterable<{ type: string; message: { role: string; content: unknown[] } }>;
    const messages: Array<{ type: string; message: { role: string; content: unknown[] } }> = [];
    for await (const msg of iter) messages.push(msg);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.type).toBe('user');
    expect(msg.message.role).toBe('user');

    const content = msg.message.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'describe this image' });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
  });

  test('handles multiple image blocks', async () => {
    const imageBlocks: ContentBlock[] = [
      { type: 'image_data', data: 'cG5n', mimeType: 'image/png' },
      { type: 'image_data', data: 'anBn', mimeType: 'image/jpeg' },
    ];

    const result = buildSDKPrompt('compare', imageBlocks);
    const iter = result as AsyncIterable<{ message: { content: unknown[] } }>;
    const messages = [];
    for await (const msg of iter) messages.push(msg);

    const content = messages[0].message.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3); // 1 text + 2 images
    expect(content[0]).toEqual({ type: 'text', text: 'compare' });
    expect((content[1] as any).source.media_type).toBe('image/png');
    expect((content[2] as any).source.media_type).toBe('image/jpeg');
  });

  test('omits text block when text prompt is empty', async () => {
    const imageBlocks: ContentBlock[] = [
      { type: 'image_data', data: 'aGVsbG8=', mimeType: 'image/png' },
    ];

    const result = buildSDKPrompt('', imageBlocks);
    const iter = result as AsyncIterable<{ message: { content: unknown[] } }>;
    const messages = [];
    for await (const msg of iter) messages.push(msg);

    const content = messages[0].message.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1); // only image, no text
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
  });
});

describe('buildSDKPrompt with file_data blocks (PDFs)', () => {
  test('converts file_data blocks to Anthropic document blocks', async () => {
    const mediaBlocks: ContentBlock[] = [
      { type: 'file_data', data: 'cGRmZGF0YQ==', mimeType: 'application/pdf', filename: 'report.pdf' },
    ];
    const result = buildSDKPrompt('summarize this pdf', mediaBlocks);
    expect(typeof result).not.toBe('string');
    const iter = result as AsyncIterable<{ message: { content: unknown[] } }>;
    const messages = [];
    for await (const msg of iter) messages.push(msg);

    const content = messages[0].message.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'summarize this pdf' });
    expect(content[1]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'cGRmZGF0YQ==' },
    });
  });

  test('handles mixed image and file_data blocks', async () => {
    const mediaBlocks: ContentBlock[] = [
      { type: 'image_data', data: 'aW1n', mimeType: 'image/png' },
      { type: 'file_data', data: 'cGRm', mimeType: 'application/pdf', filename: 'doc.pdf' },
    ];
    const result = buildSDKPrompt('analyze these', mediaBlocks);
    const iter = result as AsyncIterable<{ message: { content: unknown[] } }>;
    const messages = [];
    for await (const msg of iter) messages.push(msg);

    const content = messages[0].message.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3); // text + image + document
    expect(content[0]).toEqual({ type: 'text', text: 'analyze these' });
    expect((content[1] as any).type).toBe('image');
    expect((content[2] as any).type).toBe('document');
  });

  test('inlines non-document file_data as text', async () => {
    const textContent = 'Hello World';
    const mediaBlocks: ContentBlock[] = [
      { type: 'file_data', data: Buffer.from(textContent).toString('base64'), mimeType: 'application/xml', filename: 'data.xml' },
    ];
    const result = buildSDKPrompt('parse this', mediaBlocks);
    const iter = result as AsyncIterable<{ message: { content: unknown[] } }>;
    const messages = [];
    for await (const msg of iter) messages.push(msg);

    const content = messages[0].message.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: 'text', text: '--- data.xml ---\nHello World\n--- end ---' });
  });
});

describe('claude-code k8s HTTP transport detection', () => {
  // The claude-code runner uses direct HTTP to the host LLM proxy when
  // AX_HOST_URL is set. No bridge process needed — ANTHROPIC_BASE_URL
  // points to host's /internal/llm-proxy with per-turn token as API key.

  test('runner detects HTTP transport mode', () => {
    const source = readFileSync(
      join(__dirname, '../../../src/agent/runners/claude-code.ts'),
      'utf-8',
    );
    expect(source).toContain('AX_HOST_URL');
    expect(source).toContain('isHTTPTransport');
  });

  test('runner sets ANTHROPIC_BASE_URL to host LLM proxy in HTTP mode', () => {
    const source = readFileSync(
      join(__dirname, '../../../src/agent/runners/claude-code.ts'),
      'utf-8',
    );
    expect(source).toContain('/internal/llm-proxy');
    expect(source).toContain('AX_HOST_URL');
    expect(source).toContain('AX_IPC_TOKEN');
  });

  test('runner skips bridge in HTTP mode', () => {
    const source = readFileSync(
      join(__dirname, '../../../src/agent/runners/claude-code.ts'),
      'utf-8',
    );
    expect(source).toContain('if (isHTTPTransport)');
    expect(source).toContain('http_llm_proxy');
  });
});
