import { describe, test, expect, beforeEach } from 'vitest';
import { createWebhookHandler, type WebhookDeps } from '../../src/host/server-webhooks.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter, Readable } from 'node:stream';

// ── Test Helpers ──

interface SetupOpts {
  token: string;
  body?: string;
  transformExists?: boolean;
  transformContent?: string;
  transformResult?: { message: string; agentId?: string } | null;
  allowedAgentIds?: string[];
  maxBodyBytes?: number;
  onTaint?: (sessionId: string, content: string, isTainted: boolean) => void;
  onAudit?: (entry: { action: string; webhook: string; runId?: string; ip?: string }) => void;
}

function createMockReq(opts: { method?: string; url?: string; headers?: Record<string, string>; body?: string; remoteAddress?: string }): IncomingMessage {
  const readable = new Readable({
    read() {
      if (opts.body !== undefined) {
        this.push(Buffer.from(opts.body));
      }
      this.push(null);
    },
  });
  const req = readable as unknown as IncomingMessage;
  req.method = opts.method ?? 'POST';
  req.url = opts.url ?? '/webhooks/github';
  req.headers = opts.headers ?? {};
  // mock socket
  (req as any).socket = { remoteAddress: opts.remoteAddress ?? '127.0.0.1' };
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    headersSent: false,
    body: '',
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) Object.assign(res._headers, headers);
      res.headersSent = true;
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
    end(data?: string) {
      if (data) res.body += data;
    },
    write(data: string) {
      res.body += data;
      return true;
    },
  } as unknown as ServerResponse & { body: string; statusCode: number };
  return res;
}

function setup(opts: SetupOpts) {
  const dispatched: Array<{ result: any; runId: string }> = [];
  const deps: WebhookDeps = {
    config: {
      token: opts.token,
      ...(opts.allowedAgentIds ? { allowedAgentIds: opts.allowedAgentIds } : {}),
      ...(opts.maxBodyBytes != null ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    },
    transform: async () => 'transformResult' in opts ? opts.transformResult! : { message: 'test message' },
    dispatch: (result, runId) => dispatched.push({ result, runId }),
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: () => deps.logger,
    } as any,
    transformExists: opts.transformExists !== false
      ? () => true
      : () => false,
    readTransform: () => opts.transformContent ?? '# Test Transform',
  };
  if (opts.onTaint) {
    deps.recordTaint = opts.onTaint;
  }
  if (opts.onAudit) {
    deps.audit = opts.onAudit;
  }

  const handler = createWebhookHandler(deps);
  const mockReq = createMockReq({
    body: opts.body ?? '{"event":"push"}',
    headers: { authorization: `Bearer ${opts.token}` }, //gitleaks:allow
  });
  const mockRes = createMockRes();

  return {
    handler,
    mockReq,
    mockRes,
    dispatched,
    freshRes: () => createMockRes(),
    freshReq: (overrides?: Partial<Parameters<typeof createMockReq>[0]>) =>
      createMockReq({
        body: opts.body ?? '{"event":"push"}',
        headers: { authorization: `Bearer ${opts.token}` }, //gitleaks:allow
        ...overrides,
      }),
  };
}

// ── Tests ──

describe('webhook auth', () => {
  test('returns 401 when no token provided', async () => {
    const { handler, mockRes } = setup({ token: 'secret' });
    const req = createMockReq({ body: '{}', headers: {} });
    await handler(req, mockRes, 'github');
    expect(mockRes.statusCode).toBe(401);
  });

  test('returns 401 when token is wrong', async () => {
    const { handler, mockRes } = setup({ token: 'secret' });
    const req = createMockReq({ body: '{}', headers: { authorization: 'Bearer wrong' } }); //gitleaks:allow
    await handler(req, mockRes, 'github');
    expect(mockRes.statusCode).toBe(401);
  });

  test('accepts valid Bearer token', async () => {
    const { handler, mockReq, mockRes } = setup({ token: 'secret' });
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).not.toBe(401);
  });

  test('rejects token in query string with 400', async () => {
    const { handler, mockRes } = setup({ token: 'secret' });
    const req = createMockReq({ body: '{}', url: '/webhooks/github?token=secret', headers: {} }); //gitleaks:allow
    await handler(req, mockRes, 'github');
    expect(mockRes.statusCode).toBe(400);
  });
});

describe('webhook rate limiting', () => {
  test('returns 429 after repeated auth failures from same IP', async () => {
    const { handler, freshRes } = setup({ token: 'secret' });
    // Exhaust rate limit (20 failures per 60s window)
    for (let i = 0; i < 20; i++) {
      const req = createMockReq({ body: '{}', headers: { authorization: 'Bearer wrong' }, remoteAddress: '10.0.0.99' }); //gitleaks:allow
      await handler(req, freshRes(), 'github');
    }
    const res = freshRes();
    const req = createMockReq({ body: '{}', headers: { authorization: 'Bearer wrong' }, remoteAddress: '10.0.0.99' }); //gitleaks:allow
    await handler(req, res, 'github');
    expect(res.statusCode).toBe(429);
  });
});

describe('webhook body parsing', () => {
  test('returns 400 for invalid JSON', async () => {
    const { handler, mockRes } = setup({ token: 'secret', body: 'not json' });
    const req = createMockReq({ body: 'not json', headers: { authorization: 'Bearer secret' } }); //gitleaks:allow
    await handler(req, mockRes, 'github');
    expect(mockRes.statusCode).toBe(400);
  });

  test('returns 404 when transform file does not exist', async () => {
    const { handler, mockRes } = setup({
      token: 'secret',
      body: '{"event":"push"}',
      transformExists: false,
    });
    const req = createMockReq({ body: '{"event":"push"}', headers: { authorization: 'Bearer secret' } }); //gitleaks:allow
    await handler(req, mockRes, 'nonexistent');
    expect(mockRes.statusCode).toBe(404);
  });
});

describe('webhook method enforcement', () => {
  test('returns 405 for GET requests', async () => {
    const { handler, mockRes } = setup({ token: 'secret' });
    const req = createMockReq({ method: 'GET', body: '', headers: { authorization: 'Bearer secret' } }); //gitleaks:allow
    await handler(req, mockRes, 'github');
    expect(mockRes.statusCode).toBe(405);
  });
});

describe('webhook dispatch', () => {
  test('returns 202 with runId on successful dispatch', async () => {
    const { handler, mockReq, mockRes, dispatched } = setup({ token: 'secret' });
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(202);
    const body = JSON.parse(mockRes.body);
    expect(body.ok).toBe(true);
    expect(body.runId).toMatch(/^webhook-/);
    expect(dispatched.length).toBe(1);
  });

  test('returns 204 when transform returns null (skip)', async () => {
    const { handler, mockReq, mockRes, dispatched } = setup({
      token: 'secret',
      transformResult: null,
    });
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(204);
    expect(dispatched.length).toBe(0);
  });
});

describe('webhook taint tagging', () => {
  test('webhook payload is taint-tagged as external', async () => {
    const taintCalls: Array<{ sessionId: string; isTainted: boolean }> = [];
    const { handler, mockReq, mockRes } = setup({
      token: 'secret',
      body: '{"event":"push"}',
      onTaint: (sessionId, _content, isTainted) => {
        taintCalls.push({ sessionId, isTainted });
      },
    });
    await handler(mockReq, mockRes, 'github');
    expect(taintCalls.length).toBeGreaterThan(0);
    expect(taintCalls[0].isTainted).toBe(true);
    expect(taintCalls[0].sessionId).toMatch(/^webhook:/);
  });
});

describe('webhook audit logging', () => {
  test('webhook receipt and dispatch are audit-logged', async () => {
    const auditEntries: Array<{ action: string }> = [];
    const { handler, mockReq, mockRes } = setup({
      token: 'secret',
      body: '{"event":"push"}',
      onAudit: (entry) => auditEntries.push(entry),
    });
    await handler(mockReq, mockRes, 'github');
    expect(auditEntries).toContainEqual(expect.objectContaining({ action: 'webhook.received' }));
    expect(auditEntries).toContainEqual(expect.objectContaining({ action: 'webhook.dispatched' }));
  });

  test('webhook auth failure is audit-logged', async () => {
    const auditEntries: Array<{ action: string }> = [];
    const { handler, mockRes } = setup({
      token: 'secret',
      onAudit: (entry) => auditEntries.push(entry),
    });
    const req = createMockReq({ body: '{}', headers: { authorization: 'Bearer wrong' }, remoteAddress: '10.0.0.200' }); //gitleaks:allow
    await handler(req, mockRes, 'github');
    expect(auditEntries).toContainEqual(expect.objectContaining({ action: 'webhook.auth_failed' }));
  });
});

describe('webhook allowlist enforcement', () => {
  test('blocks dispatch when allowlist is set but transform omits agentId', async () => {
    const { handler, mockReq, mockRes, dispatched } = setup({
      token: 'secret',
      allowedAgentIds: ['agent-a', 'agent-b'],
      transformResult: { message: 'hello' }, // no agentId
    });
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(400);
    expect(mockRes.body).toContain('not in allowed list');
    expect(dispatched.length).toBe(0);
  });

  test('blocks dispatch when agentId is not in allowlist', async () => {
    const { handler, mockReq, mockRes, dispatched } = setup({
      token: 'secret',
      allowedAgentIds: ['agent-a'],
      transformResult: { message: 'hello', agentId: 'agent-c' },
    });
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(400);
    expect(dispatched.length).toBe(0);
  });

  test('allows dispatch when agentId is in allowlist', async () => {
    const { handler, mockReq, mockRes, dispatched } = setup({
      token: 'secret',
      allowedAgentIds: ['agent-a'],
      transformResult: { message: 'hello', agentId: 'agent-a' },
    });
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(202);
    expect(dispatched.length).toBe(1);
  });

  test('skips allowlist check when no allowlist is configured', async () => {
    const { handler, mockReq, mockRes, dispatched } = setup({
      token: 'secret',
      transformResult: { message: 'hello' }, // no agentId, no allowlist
    });
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(202);
    expect(dispatched.length).toBe(1);
  });
});

describe('webhook body size limit', () => {
  test('rejects payload exceeding configured max_body_bytes', async () => {
    const { handler, mockRes } = setup({
      token: 'secret',
      maxBodyBytes: 64,
    });
    const bigBody = JSON.stringify({ data: 'x'.repeat(100) });
    const req = createMockReq({ body: bigBody, headers: { authorization: 'Bearer secret' } }); //gitleaks:allow
    await handler(req, mockRes, 'github');
    expect(mockRes.statusCode).toBe(413);
  });

  test('accepts payload within configured max_body_bytes', async () => {
    const { handler, mockRes } = setup({
      token: 'secret',
      maxBodyBytes: 1024,
    });
    const req = createMockReq({ body: '{"ok":true}', headers: { authorization: 'Bearer secret' } }); //gitleaks:allow
    await handler(req, mockRes, 'github');
    expect(mockRes.statusCode).not.toBe(413);
  });
});
