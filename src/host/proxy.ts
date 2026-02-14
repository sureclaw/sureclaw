/**
 * Credential-injecting forward proxy for the Anthropic Messages API.
 *
 * Listens on a Unix socket. Agents send standard Anthropic API requests
 * with a dummy x-api-key. The proxy strips the dummy key, injects real
 * credentials from the host environment, and forwards to the Anthropic API.
 *
 * Supports both API key and OAuth token authentication:
 * - ANTHROPIC_API_KEY -> x-api-key header (takes precedence)
 * - CLAUDE_CODE_OAUTH_TOKEN -> Authorization: Bearer header
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { debug } from '../logger.js';

const SRC = 'host:proxy';

const DEFAULT_TARGET = 'https://api.anthropic.com';

export function startAnthropicProxy(
  proxySocketPath: string,
  targetBaseUrl?: string,
): { server: Server; stop: () => void } {
  const target = targetBaseUrl ?? DEFAULT_TARGET;

  // Clean up stale socket
  if (existsSync(proxySocketPath)) {
    unlinkSync(proxySocketPath);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Forward any /v1/ path (handles query strings like ?beta=true)
    if (!req.url?.startsWith('/v1/') || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'Not found' } }));
      return;
    }

    try {
      const body = await readBody(req);
      await forwardWithCredentials(target, body, req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: (err as Error).message },
      }));
    }
  });

  server.listen(proxySocketPath);

  return {
    server,
    stop: () => {
      server.close();
      try { unlinkSync(proxySocketPath); } catch { /* ignore */ }
    },
  };
}

/**
 * Forward the request to the Anthropic API with real credentials injected.
 * Streams the response back to the agent.
 */
async function forwardWithCredentials(
  targetBaseUrl: string,
  body: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  // Fail fast when no credentials are available — don't send unauthenticated
  // requests to the Anthropic API and wait for a cryptic 401.
  if (!apiKey && !oauthToken) {
    debug(SRC, 'no_credentials', { url: req.url });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'No API credentials configured. Run `ax configure` to set up authentication.',
      },
    }));
    return;
  }

  // Build outbound headers — copy from agent, then replace auth
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || key === 'host' || key === 'connection' || key === 'content-length') continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  // Inject real credentials (API key takes precedence over OAuth)
  if (apiKey) {
    headers.set('x-api-key', apiKey);
    headers.delete('authorization');
  } else if (oauthToken) {
    headers.set('authorization', `Bearer ${oauthToken}`);
    headers.delete('x-api-key');
    // OAuth tokens require Claude Code identity headers.
    // Without these, the API returns 401 "OAuth authentication is currently not supported."
    headers.set('anthropic-dangerous-direct-browser-access', 'true');
    headers.set('x-app', 'cli');
    headers.set('user-agent', 'claude-cli/2.1.38 (external, cli)');
    // Merge oauth beta flag into existing anthropic-beta header
    const existingBeta = headers.get('anthropic-beta') ?? '';
    const betaParts = existingBeta ? existingBeta.split(',').map(s => s.trim()) : [];
    if (!betaParts.includes('claude-code-20250219')) betaParts.push('claude-code-20250219');
    if (!betaParts.includes('oauth-2025-04-20')) betaParts.push('oauth-2025-04-20');
    headers.set('anthropic-beta', betaParts.join(','));
  }

  // For OAuth, inject Claude Code system prompt identity into /v1/messages body.
  // The API validates that OAuth requests include the Claude Code identity.
  let finalBody = body;
  if (!apiKey && oauthToken && req.url?.startsWith('/v1/messages')) {
    try {
      const parsed = JSON.parse(body);
      const identityPrompt = "You are Claude Code, Anthropic's official CLI for Claude.";
      const systemBlocks = Array.isArray(parsed.system)
        ? parsed.system
        : parsed.system
          ? [{ type: 'text', text: parsed.system }]
          : [];
      const hasIdentity = systemBlocks.some(
        (b: { text?: string }) => b.text?.includes(identityPrompt),
      );
      if (!hasIdentity) {
        systemBlocks.unshift({ type: 'text', text: identityPrompt });
      }
      parsed.system = systemBlocks;
      finalBody = JSON.stringify(parsed);
    } catch {
      // If body isn't valid JSON, forward as-is
    }
  }

  const response = await fetch(`${targetBaseUrl}${req.url}`, {
    method: 'POST',
    headers,
    body: finalBody,
  });

  // Log non-2xx responses — helps diagnose auth failures (401), rate limits (429), etc.
  if (response.status >= 400) {
    debug(SRC, 'upstream_error', {
      status: response.status,
      url: req.url,
      authMethod: apiKey ? 'api-key' : oauthToken ? 'oauth' : 'none',
    });
  }

  // Forward status + headers back to agent
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    // fetch() auto-decompresses, so strip encoding headers to avoid double-decompress
    if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') outHeaders[k] = v;
  });
  res.writeHead(response.status, outHeaders);

  // Stream response body through
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX_BODY = 4 * 1024 * 1024; // 4MB
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
