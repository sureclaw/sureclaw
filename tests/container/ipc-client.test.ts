import { describe, test, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IPCClient } from '../../src/container/ipc-client.js';

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
});
