/**
 * TCP-to-Unix-socket bridge for the HTTP forward proxy.
 *
 * Inside Docker/Apple containers (--network=none), agents can't reach the
 * host web proxy directly via TCP. This bridge listens on 127.0.0.1:{PORT}
 * (loopback works even with --network=none) and forwards connections to the
 * host's web proxy via a mounted Unix socket.
 *
 * Handles both HTTP forwarding and HTTPS CONNECT tunneling:
 * - Regular HTTP requests: forwarded via undici Agent with socketPath
 * - CONNECT requests: raw TCP pipe to Unix socket, proxy handles outbound
 *
 * Same pattern as tcp-bridge.ts, but for the web forward proxy instead of
 * the Anthropic credential-injecting proxy.
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface WebProxyBridge {
  port: number;
  stop: () => void;
}

export async function startWebProxyBridge(unixSocketPath: string): Promise<WebProxyBridge> {
  const { Agent } = await import('undici');
  const dispatcher = new Agent({ connect: { socketPath: unixSocketPath } });
  const activeSockets = new Set<net.Socket>();

  // ── HTTP forwarding ──
  // Regular HTTP requests are forwarded through undici with socketPath.
  // The host proxy sees a normal HTTP request and handles forwarding.

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      // Forward headers (strip hop-by-hop and encoding headers — fetch handles these)
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || key === 'host' || key === 'connection' || key === 'proxy-connection'
            || key === 'transfer-encoding' || key === 'content-length') continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }

      // Forward to Unix socket proxy — use the full URL as the path
      // (HTTP proxy protocol sends the complete URL, not just the path)
      const response = await fetch(`http://localhost${req.url}`, {
        method: req.method ?? 'GET',
        headers,
        body: body.length > 0 ? body : undefined,
        dispatcher,
      } as RequestInit);

      // Stream response back
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') {
          outHeaders[k] = v;
        }
      });
      res.writeHead(response.status, outHeaders);

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
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Bridge error: ${(err as Error).message}`);
    }
  });

  // ── CONNECT tunneling ──
  // For HTTPS CONNECT, we open a raw socket to the Unix socket proxy
  // and pipe bytes bidirectionally. The proxy handles the actual outbound
  // TCP connection after receiving the CONNECT header.

  server.on('connect', (req: IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const target = req.url ?? '';

    // Open a raw connection to the Unix socket proxy
    const proxySocket = net.connect(unixSocketPath, () => {
      activeSockets.add(proxySocket);

      // Send the CONNECT request through to the host proxy
      proxySocket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
      );

      // Wait for the proxy's response before piping
      let headerBuffer = '';
      const onData = (chunk: Buffer) => {
        headerBuffer += chunk.toString();
        const headerEnd = headerBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return; // Keep waiting for full header

        proxySocket.removeListener('data', onData);

        // Check if proxy established the connection
        if (headerBuffer.startsWith('HTTP/1.1 200')) {
          // Forward the 200 response to client
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

          // Pipe remaining data (after headers) and future data
          const remaining = headerBuffer.slice(headerEnd + 4);
          if (remaining.length > 0) {
            clientSocket.write(remaining);
          }

          // Forward any initial data from the client
          if (head.length > 0) {
            proxySocket.write(head);
          }

          // Bidirectional pipe
          proxySocket.pipe(clientSocket);
          clientSocket.pipe(proxySocket);
        } else {
          // Forward error response
          clientSocket.write(headerBuffer);
          clientSocket.end();
          proxySocket.end();
        }
      };

      proxySocket.on('data', onData);
    });

    const cleanup = () => {
      activeSockets.delete(proxySocket);
      proxySocket.destroy();
      clientSocket.destroy();
    };

    proxySocket.on('error', cleanup);
    proxySocket.on('close', cleanup);
    clientSocket.on('error', cleanup);
    clientSocket.on('close', cleanup);
  });

  // ── Start listening ──

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  return {
    port,
    stop: () => {
      for (const s of activeSockets) s.destroy();
      activeSockets.clear();
      server.close();
    },
  };
}
