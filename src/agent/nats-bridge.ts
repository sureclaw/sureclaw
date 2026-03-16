// src/agent/nats-bridge.ts — HTTP-to-NATS bridge for claude-code sandbox pods.
//
// In k8s, claude-code agents run in sandbox pods without API credentials.
// This bridge provides a local HTTP server that Claude Code CLI hits via
// ANTHROPIC_BASE_URL. Instead of forwarding to a Unix socket proxy (like
// tcp-bridge.ts does locally), it publishes NATS requests to the host pod,
// which proxies to the Anthropic API.
//
// Flow:
//   Claude Code CLI
//     → HTTP to localhost:{PORT}
//     → nats-bridge.ts publishes to ipc.llm.{requestId}.{token}
//     → Host pod claims, proxies to Anthropic API
//     → Response via NATS reply → bridge → Claude Code CLI

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { natsConnectOptions } from '../utils/nats.js';

export interface NATSBridge {
  port: number;
  stop: () => Promise<void>;
}

/** NATS subjects for claude-code sandbox pod communication (token-scoped). */
function llmSubject(requestId: string, token: string): string {
  return `ipc.llm.${requestId}.${token}`;
}

/**
 * LLM proxy request — sent from sandbox pod to agent runtime via NATS.
 * The agent runtime pod forwards to the Anthropic API and streams back.
 */
interface LLMProxyRequest {
  type: 'llm_proxy';
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * LLM proxy response — returned from agent runtime via NATS reply.
 * For streaming responses, the body contains the full SSE stream.
 */
interface LLMProxyResponse {
  type: 'llm_proxy_response';
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Default timeout for LLM proxy requests (5 min — long completions). */
const LLM_PROXY_TIMEOUT_MS = 300_000;

/**
 * Start the NATS bridge for a claude-code sandbox pod.
 *
 * Creates a local HTTP server that Claude Code CLI uses as ANTHROPIC_BASE_URL.
 * Forwards all requests to the agent runtime pod via NATS request/reply.
 */
export async function startNATSBridge(options: {
  sessionId: string;
  requestId: string;
  token: string;
  natsUrl?: string;
}): Promise<NATSBridge> {
  const { sessionId, requestId, token } = options;

  const natsModule = await import('nats');
  const nc = await natsModule.connect(natsConnectOptions('nats-bridge', sessionId));

  const subject = llmSubject(requestId, token);

  function encode(obj: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  function decode<T>(data: Uint8Array): T {
    return JSON.parse(new TextDecoder().decode(data)) as T;
  }

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Read request body
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_BODY = 4 * 1024 * 1024;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString('utf-8');

      // Build headers (strip host/connection)
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || key === 'host' || key === 'connection') continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }

      // Send via NATS request/reply
      const proxyReq: LLMProxyRequest = {
        type: 'llm_proxy',
        method: req.method ?? 'POST',
        path: req.url ?? '/v1/messages',
        headers,
        body,
      };

      const response = await nc.request(
        subject,
        encode(proxyReq),
        { timeout: LLM_PROXY_TIMEOUT_MS },
      );

      const proxyRes = decode<LLMProxyResponse>(response.data);

      // Forward response back to Claude Code CLI
      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        // Skip encoding headers — the NATS round-trip already decompresses
        if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') {
          outHeaders[k] = v;
        }
      }

      res.writeHead(proxyRes.status, outHeaders);
      res.end(proxyRes.body);
    } catch (err) {
      console.error(`[nats-bridge] proxy error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: (err as Error).message },
      }));
    }
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  console.log(`[nats-bridge] listening on 127.0.0.1:${port}, session=${sessionId}`);

  return {
    port,
    async stop() {
      server.close();
      await nc.drain();
    },
  };
}
