// src/host/nats-llm-proxy.ts — NATS-based LLM proxy for claude-code sandbox pods.
//
// Subscribes to ipc.llm.{requestId}.{token} and proxies requests to the
// Anthropic API with real credentials injected. This allows claude-code
// pods to make LLM calls without having API credentials.
//
// The per-turn capability token prevents rogue sandbox pods from
// intercepting LLM requests meant for other sessions.

import { getLogger } from '../logger.js';
import { natsConnectOptions } from '../utils/nats.js';

const logger = getLogger().child({ component: 'nats-llm-proxy' });

/** Default Anthropic API base URL. */
const DEFAULT_TARGET = 'https://api.anthropic.com';

interface LLMProxyRequest {
  type: 'llm_proxy';
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface LLMProxyResponse {
  type: 'llm_proxy_response';
  status: number;
  headers: Record<string, string>;
  body: string;
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function decode<T>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Start an LLM proxy that subscribes to ipc.llm.{requestId}.{token}
 * via NATS and forwards requests to the Anthropic API.
 *
 * Returns a cleanup function to unsubscribe.
 */
export async function startNATSLLMProxy(options: {
  requestId: string;
  token: string;
  targetBaseUrl?: string;
  refreshCredentials?: () => Promise<void>;
}): Promise<{ close: () => void }> {
  const natsModule = await import('nats');

  const target = options.targetBaseUrl ?? DEFAULT_TARGET;
  const subject = `ipc.llm.${options.requestId}.${options.token}`;

  const nc = await natsModule.connect(natsConnectOptions('llm-proxy', options.requestId));

  const sub = nc.subscribe(subject);

  logger.info('llm_proxy_started', { requestId: options.requestId, subject });

  // Process LLM proxy requests
  (async () => {
    for await (const msg of sub) {
      let req: LLMProxyRequest;
      try {
        req = decode<LLMProxyRequest>(msg.data);
      } catch (err) {
        logger.error('llm_proxy_decode_error', { error: (err as Error).message });
        if (msg.reply) {
          msg.respond(encode({
            type: 'llm_proxy_response',
            status: 400,
            headers: {},
            body: JSON.stringify({ error: 'Invalid proxy request' }),
          } satisfies LLMProxyResponse));
        }
        continue;
      }

      try {
        const proxyRes = await forwardToAnthropic(target, req, options.refreshCredentials);

        if (msg.reply) {
          msg.respond(encode(proxyRes));
        }
      } catch (err) {
        logger.error('llm_proxy_forward_error', { error: (err as Error).message });
        if (msg.reply) {
          msg.respond(encode({
            type: 'llm_proxy_response',
            status: 502,
            headers: {},
            body: JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: (err as Error).message },
            }),
          } satisfies LLMProxyResponse));
        }
      }
    }
  })().catch((err) => {
    logger.error('llm_proxy_loop_error', { error: (err as Error).message });
  });

  return {
    close() {
      sub.unsubscribe();
      void nc.drain();
    },
  };
}

/**
 * Forward an LLM request to the Anthropic API with credentials injected.
 */
async function forwardToAnthropic(
  targetBaseUrl: string,
  req: LLMProxyRequest,
  refreshCredentials?: () => Promise<void>,
  isRetry = false,
): Promise<LLMProxyResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  if (!apiKey && !oauthToken) {
    return {
      type: 'llm_proxy_response',
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'No API credentials configured.',
        },
      }),
    };
  }

  // Build headers with real credentials
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === 'host' || key === 'connection' || key === 'content-length') continue;
    headers.set(key, value);
  }

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

  // For OAuth, inject Claude Code identity into request body
  let finalBody = req.body;
  if (!apiKey && oauthToken && req.path.startsWith('/v1/messages')) {
    try {
      const parsed = JSON.parse(req.body);
      const identityPrompt = "You are Claude Code, Anthropic's official CLI for Claude.";
      const systemBlocks = Array.isArray(parsed.system)
        ? parsed.system
        : parsed.system ? [{ type: 'text', text: parsed.system }] : [];
      const hasIdentity = systemBlocks.some(
        (b: { text?: string }) => b.text?.includes(identityPrompt),
      );
      if (!hasIdentity) systemBlocks.unshift({ type: 'text', text: identityPrompt });
      parsed.system = systemBlocks;
      finalBody = JSON.stringify(parsed);
    } catch { /* forward as-is */ }
  }

  const response = await fetch(`${targetBaseUrl}${req.path}`, {
    method: req.method,
    headers,
    body: finalBody,
  });

  // Reactive retry on OAuth 401
  if (response.status === 401 && !isRetry && !apiKey && oauthToken && refreshCredentials) {
    let errorBody = '';
    try { errorBody = await response.text(); } catch { /* ignore */ }
    logger.info('oauth_401_retry', { path: req.path });
    try {
      await refreshCredentials();
      return forwardToAnthropic(targetBaseUrl, req, refreshCredentials, true);
    } catch {
      return {
        type: 'llm_proxy_response',
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: errorBody,
      };
    }
  }

  // Collect response
  const resHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') {
      resHeaders[k] = v;
    }
  });

  const body = await response.text();

  return {
    type: 'llm_proxy_response',
    status: response.status,
    headers: resHeaders,
    body,
  };
}
