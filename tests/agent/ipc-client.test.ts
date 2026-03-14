import { describe, test, expect, afterEach } from 'vitest';
import { connect, createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IPCClient } from '../../src/agent/ipc-client.js';

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
        const response = handler(request);
        const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(responseBuf.length, 0);
        socket.write(Buffer.concat([lenBuf, responseBuf]));
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

        // Send heartbeats
        const hbInterval = setInterval(() => {
          const hb = JSON.stringify({ _heartbeat: true, ts: Date.now() });
          const hbBuf = Buffer.from(hb, 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(hbBuf.length, 0);
          socket.write(Buffer.concat([lenBuf, hbBuf]));
        }, 50);

        // Send real response after 300ms (longer than the 150ms timeout)
        setTimeout(() => {
          clearInterval(hbInterval);
          const resp = JSON.stringify({ ok: true, result: 'done' });
          const respBuf = Buffer.from(resp, 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(respBuf.length, 0);
          socket.write(Buffer.concat([lenBuf, respBuf]));
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

        // Send one heartbeat after 30ms
        setTimeout(() => {
          const hb = JSON.stringify({ _heartbeat: true, ts: Date.now() });
          const hbBuf = Buffer.from(hb, 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(hbBuf.length, 0);
          socket.write(Buffer.concat([lenBuf, hbBuf]));
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
          const response = JSON.stringify({ ok: true, echo: request.action });
          const responseBuf = Buffer.from(response, 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(responseBuf.length, 0);
          hostSocket.write(Buffer.concat([lenBuf, responseBuf]));
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

          const response = JSON.stringify({ ok: true });
          const responseBuf = Buffer.from(response, 'utf-8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(responseBuf.length, 0);
          hostSocket.write(Buffer.concat([lenBuf, responseBuf]));
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

        function sendFrame(obj: Record<string, unknown>) {
          const json = JSON.stringify(obj);
          const buf = Buffer.from(json, 'utf-8');
          const len = Buffer.alloc(4);
          len.writeUInt32BE(buf.length, 0);
          socket.write(Buffer.concat([len, buf]));
        }

        let count = 0;
        const iv = setInterval(() => {
          count++;
          if (count <= 3) {
            sendFrame({ _heartbeat: true, ts: Date.now() });
          } else {
            clearInterval(iv);
            sendFrame({ ok: true, data: 'final' });
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
