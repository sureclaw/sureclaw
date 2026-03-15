import { describe, test, expect, afterEach } from 'vitest';
import { connect, createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IPCClient } from '../../src/agent/ipc-client.js';

/** Send a length-prefixed JSON frame over a socket. */
function sendFrame(socket: import('node:net').Socket, obj: Record<string, unknown>) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  socket.write(Buffer.concat([len, buf]));
}

function createMockServer(socketPath: string, handler: (req: Record<string, unknown>) => Record<string, unknown>): Server {
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
        const msgId = request._msgId;
        const response = { ...handler(request), ...(msgId ? { _msgId: msgId } : {}) };
        sendFrame(socket, response);
      }
    });
  });

  server.listen(socketPath);
  return server;
}

/** Like createMockServer but handler is async (supports delays). */
function createAsyncMockServer(socketPath: string, handler: (req: Record<string, unknown>, socket: import('node:net').Socket) => Promise<void>): Server {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);

    socket.on('data', async (data) => {
      buffer = Buffer.concat([buffer, data]);

      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) break;

        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        buffer = buffer.subarray(4 + msgLen);

        const request = JSON.parse(raw);
        await handler(request, socket);
      }
    });
  });

  server.listen(socketPath);
  return server;
}

describe('IPCClient', () => {
  let tmpDir: string;
  let server: Server;

  afterEach(() => {
    server?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sends request and receives response', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'test.sock');

    server = createMockServer(socketPath, (req) => {
      return { ok: true, echo: req.action };
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => server.on('listening', resolve));

    const client = new IPCClient({ socketPath });
    const result = await client.call({ action: 'skill_list' });

    expect(result.ok).toBe(true);
    expect(result.echo).toBe('skill_list');

    client.disconnect();
  });

  test('handles multiple sequential calls', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'test.sock');
    let callCount = 0;

    server = createMockServer(socketPath, () => {
      callCount++;
      return { ok: true, count: callCount };
    });

    await new Promise<void>((resolve) => server.on('listening', resolve));

    const client = new IPCClient({ socketPath });

    const r1 = await client.call({ action: 'call1' });
    const r2 = await client.call({ action: 'call2' });

    expect(r1.count).toBe(1);
    expect(r2.count).toBe(2);

    client.disconnect();
  });

  test('handles concurrent calls — each gets correct response', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'test.sock');

    // Server echoes the action back with a per-action delay to simulate
    // responses arriving in a different order than requests were sent
    server = createAsyncMockServer(socketPath, async (req, socket) => {
      const action = req.action as string;
      const msgId = req._msgId as string | undefined;
      // Stagger responses: call_a responds last, call_c responds first
      const delays: Record<string, number> = { call_a: 80, call_b: 40, call_c: 10 };
      const delay = delays[action] ?? 0;
      await new Promise<void>(r => setTimeout(r, delay));
      sendFrame(socket, { ok: true, action, ...(msgId ? { _msgId: msgId } : {}) });
    });

    await new Promise<void>((resolve) => server.on('listening', resolve));

    const client = new IPCClient({ socketPath });

    // Fire 3 calls concurrently
    const [ra, rb, rc] = await Promise.all([
      client.call({ action: 'call_a' }),
      client.call({ action: 'call_b' }),
      client.call({ action: 'call_c' }),
    ]);

    // Each call must receive its own response, not someone else's
    expect(ra.action).toBe('call_a');
    expect(rb.action).toBe('call_b');
    expect(rc.action).toBe('call_c');

    client.disconnect();
  }, 5000);

  test('rejects on connection error', async () => {
    const client = new IPCClient({ socketPath: '/tmp/nonexistent-socket-path.sock' });

    await expect(client.call({ action: 'test' })).rejects.toThrow();
  });

  test('times out on slow response', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'test.sock');

    // Server that never responds
    server = createServer(() => {});
    server.listen(socketPath);

    await new Promise<void>((resolve) => server.on('listening', resolve));

    const client = new IPCClient({ socketPath, timeoutMs: 200 });

    await expect(client.call({ action: 'test' })).rejects.toThrow('timed out');

    client.disconnect();
  }, 5000);

  test('heartbeats reset timeout — client survives long operation', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'test.sock');

    // Server sends heartbeats every 50ms, then responds after 300ms
    server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length < 4) return;
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) return;

        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        const request = JSON.parse(raw);
        const msgId = request._msgId;

        // Send heartbeats with _msgId
        const hbInterval = setInterval(() => {
          sendFrame(socket, { _heartbeat: true, ts: Date.now(), ...(msgId ? { _msgId: msgId } : {}) });
        }, 50);

        // Send real response after 300ms (longer than the 150ms timeout)
        setTimeout(() => {
          clearInterval(hbInterval);
          sendFrame(socket, { ok: true, result: 'done', ...(msgId ? { _msgId: msgId } : {}) });
        }, 300);
      });
    });
    server.listen(socketPath);
    await new Promise<void>((resolve) => server.on('listening', resolve));

    // Timeout is 150ms — without heartbeats this would fail
    const client = new IPCClient({ socketPath, timeoutMs: 150 });
    const result = await client.call({ action: 'test' });

    expect(result.ok).toBe(true);
    expect(result.result).toBe('done');

    client.disconnect();
  }, 5000);

  test('times out when heartbeats stop arriving', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'test.sock');

    // Server sends one heartbeat then stops — never sends a real response
    server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length < 4) return;
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) return;

        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        const request = JSON.parse(raw);
        const msgId = request._msgId;

        // Send one heartbeat after 30ms
        setTimeout(() => {
          sendFrame(socket, { _heartbeat: true, ts: Date.now(), ...(msgId ? { _msgId: msgId } : {}) });
        }, 30);
        // Then silence — no more heartbeats, no response
      });
    });
    server.listen(socketPath);
    await new Promise<void>((resolve) => server.on('listening', resolve));

    const client = new IPCClient({ socketPath, timeoutMs: 150 });

    await expect(client.call({ action: 'test' })).rejects.toThrow('no heartbeat');

    client.disconnect();
  }, 5000);

  test('listen mode: accepts connection and handles call', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'listen.sock');

    // Create client in listen mode — it will create a server and wait
    const client = new IPCClient({ socketPath, listen: true });
    const connectPromise = client.connect();

    // Give the server a moment to start listening, then connect to it
    // and act as the "host" side — read requests, send responses
    await new Promise<void>(r => setTimeout(r, 50));

    const hostSocket = connect(socketPath);
    await new Promise<void>((resolve) => hostSocket.once('connect', resolve));

    // Wait for listen mode to accept the connection
    await connectPromise;

    // Now set up the host side to handle the request
    const responsePromise = new Promise<void>((resolve) => {
      let buffer = Buffer.alloc(0);
      hostSocket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          const msgLen = buffer.readUInt32BE(0);
          if (buffer.length < 4 + msgLen) return;
          const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
          buffer = buffer.subarray(4 + msgLen);

          const request = JSON.parse(raw);
          sendFrame(hostSocket, { ok: true, echo: request.action, _msgId: request._msgId });
          resolve();
        }
      });
    });

    const result = await client.call({ action: 'test_listen' });
    await responsePromise;

    expect(result.ok).toBe(true);
    expect(result.echo).toBe('test_listen');

    hostSocket.destroy();
    client.disconnect();
  });

  test('setContext updates sessionId on listen-mode client', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'listen.sock');

    // Create client in listen mode WITHOUT sessionId (mimics Apple Container boot)
    const client = new IPCClient({ socketPath, listen: true });
    const connectPromise = client.connect();

    await new Promise<void>(r => setTimeout(r, 50));

    const hostSocket = connect(socketPath);
    await new Promise<void>((resolve) => hostSocket.once('connect', resolve));
    await connectPromise;

    // Apply session context AFTER connection (mimics stdin parse completing)
    client.setContext({ sessionId: 'test-session-42', userId: 'alice' });

    // Host side: capture the raw request to verify _sessionId is present
    const requestPromise = new Promise<Record<string, unknown>>((resolve) => {
      let buffer = Buffer.alloc(0);
      hostSocket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          const msgLen = buffer.readUInt32BE(0);
          if (buffer.length < 4 + msgLen) return;
          const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
          buffer = buffer.subarray(4 + msgLen);

          const request = JSON.parse(raw);
          resolve(request);

          sendFrame(hostSocket, { ok: true, _msgId: request._msgId });
        }
      });
    });

    await client.call({ action: 'sandbox_bash', command: 'ls' });
    const capturedRequest = await requestPromise;

    expect(capturedRequest._sessionId).toBe('test-session-42');
    expect(capturedRequest._userId).toBe('alice');

    hostSocket.destroy();
    client.disconnect();
  });

  test('resolves actual response after multiple heartbeats', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-test-'));
    const socketPath = join(tmpDir, 'test.sock');

    // Server sends 3 heartbeats then the real response
    server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length < 4) return;
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) return;

        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        const request = JSON.parse(raw);
        const msgId = request._msgId;

        let count = 0;
        const iv = setInterval(() => {
          count++;
          if (count <= 3) {
            sendFrame(socket, { _heartbeat: true, ts: Date.now(), ...(msgId ? { _msgId: msgId } : {}) });
          } else {
            clearInterval(iv);
            sendFrame(socket, { ok: true, data: 'final', ...(msgId ? { _msgId: msgId } : {}) });
          }
        }, 40);
      });
    });
    server.listen(socketPath);
    await new Promise<void>((resolve) => server.on('listening', resolve));

    const client = new IPCClient({ socketPath, timeoutMs: 150 });
    const result = await client.call({ action: 'test' });

    expect(result.ok).toBe(true);
    expect(result.data).toBe('final');

    client.disconnect();
  }, 5000);
});
