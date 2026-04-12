// src/host/llm-proxy-core.ts — Shared LLM credential injection and forwarding.
//
// Used by both the Unix socket proxy (proxy.ts, for docker/apple)
// and the HTTP route (/internal/llm-proxy, for k8s).

import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'llm-proxy-core' });

const DEFAULT_TARGET = 'https://api.anthropic.com';

export interface ForwardLLMRequestOptions {
  /** The API path, e.g. /v1/messages?beta=true */
  targetPath: string;
  /** Request body (string) */
  body: string;
  /** Incoming headers from the agent (to forward anthropic-version, etc.) */
  incomingHeaders: IncomingHttpHeaders;
  /** Response object to stream the upstream response into */
  res: ServerResponse;
  /** Target base URL (default: https://api.anthropic.com) */
  targetBaseUrl?: string;
  /** Callback to refresh credentials on 401 */
  refreshCredentials?: () => Promise<void>;
}

/**
 * Forward an LLM request to the Anthropic API with real credentials injected.
 * Streams the response back. Handles OAuth retry on 401.
 */
export async function forwardLLMRequest(
  opts: ForwardLLMRequestOptions,
  isRetry = false,
): Promise<void> {
  const { targetPath, body, incomingHeaders, res, refreshCredentials } = opts;
  const targetBaseUrl = opts.targetBaseUrl ?? DEFAULT_TARGET;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  if (!apiKey && !oauthToken) {
    logger.warn('no_credentials', { url: targetPath });
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

  // Build outbound headers
  const headers = new Headers();
  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (!value || key === 'host' || key === 'connection' || key === 'content-length') continue;
    // Skip auth headers — we inject real credentials below
    if (key === 'authorization' || key === 'x-api-key') continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  // Inject real credentials
  if (apiKey) {
    headers.set('x-api-key', apiKey);
    headers.delete('authorization');
  } else if (oauthToken) {
    headers.set('authorization', `Bearer ${oauthToken}`);
    headers.delete('x-api-key');
    headers.set('anthropic-dangerous-direct-browser-access', 'true');
    headers.set('x-app', 'cli');
    headers.set('user-agent', 'claude-cli/2.1.38 (external, cli)');
    const existingBeta = headers.get('anthropic-beta') ?? '';
    const betaParts = existingBeta ? existingBeta.split(',').map(s => s.trim()) : [];
    if (!betaParts.includes('claude-code-20250219')) betaParts.push('claude-code-20250219');
    if (!betaParts.includes('oauth-2025-04-20')) betaParts.push('oauth-2025-04-20');
    headers.set('anthropic-beta', betaParts.join(','));
  }

  // For OAuth, inject Claude Code identity into /v1/messages body
  let finalBody = body;
  if (!apiKey && oauthToken && targetPath.startsWith('/v1/messages')) {
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

  headers.set('content-type', 'application/json');

  const response = await fetch(`${targetBaseUrl}${targetPath}`, {
    method: 'POST',
    headers,
    body: finalBody,
  });

  if (response.status >= 400) {
    logger.warn('upstream_error', {
      status: response.status,
      url: targetPath,
      authMethod: apiKey ? 'api-key' : oauthToken ? 'oauth' : 'none',
    });
  }

  // Reactive retry on OAuth 401
  if (response.status === 401 && !isRetry && !apiKey && oauthToken && refreshCredentials) {
    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }

    logger.info('oauth_401_retry', { url: targetPath });
    try {
      await refreshCredentials();
      return forwardLLMRequest(opts, true);
    } catch (err) {
      logger.warn('oauth_refresh_on_401_failed', { error: (err as Error).message });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(errorBody);
      return;
    }
  }

  // Forward status + headers
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') outHeaders[k] = v;
  });
  res.writeHead(response.status, outHeaders);

  // Stream response body
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
