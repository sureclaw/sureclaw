import { describe, test, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
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

describe('IPCClient reconnect', () => {
  let tmpDir: string;
  let server: Server | null = null;

  afterEach(() => {
    if (server) { server.close(); server = null; }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('isConnectionError classifies errors correctly', () => {
    // Access private method via casting — just verifying the classification logic
    const client = new IPCClient({ socketPath: '/tmp/dummy.sock' }) as any;

    // Connection-level errors → should trigger reconnect
    expect(client.isConnectionError(new Error('write EPIPE'))).toBe(true);
    expect(client.isConnectionError(new Error('read ECONNRESET'))).toBe(true);
    expect(client.isConnectionError(new Error('connect ECONNREFUSED'))).toBe(true);
    expect(client.isConnectionError(new Error('this socket has been ended'))).toBe(true);
    expect(client.isConnectionError(new Error('socket destroyed'))).toBe(true);
    expect(client.isConnectionError(new Error('Not connected'))).toBe(true);

    // Timeouts should NOT trigger reconnect (call may have been received)
    expect(client.isConnectionError(new Error('IPC call timed out after 30000ms'))).toBe(false);
    // Non-Error objects
    expect(client.isConnectionError('string error')).toBe(false);
    // Regular errors that aren't connection-related
    expect(client.isConnectionError(new Error('some other error'))).toBe(false);
    expect(client.isConnectionError(new Error('JSON parse failed'))).toBe(false);
  });

  test('maxReconnectAttempts option is respected', () => {
    const client = new IPCClient({ socketPath: '/tmp/dummy.sock', maxReconnectAttempts: 5 }) as any;
    expect(client.maxReconnectAttempts).toBe(5);
  });

  test('default maxReconnectAttempts is 3', () => {
    const client = new IPCClient({ socketPath: '/tmp/dummy.sock' }) as any;
    expect(client.maxReconnectAttempts).toBe(3);
  });

  test('auto-reconnects on initial call when not connected', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-reconnect-'));
    const socketPath = join(tmpDir, 'test.sock');

    // Start server AFTER creating client (client isn't connected yet)
    const client = new IPCClient({ socketPath, maxReconnectAttempts: 2 });

    server = createMockServer(socketPath, () => ({ ok: true, msg: 'connected' }));
    await new Promise<void>((resolve) => server!.on('listening', resolve));

    // Should auto-connect on first call
    const result = await client.call({ action: 'test' });
    expect(result.ok).toBe(true);

    client.disconnect();
  });

  test('disconnect resets connected state', () => {
    const client = new IPCClient({ socketPath: '/tmp/dummy.sock' }) as any;

    // Simulate connected state
    client.connected = true;
    client.socket = { destroy: () => {} };

    client.disconnect();
    expect(client.connected).toBe(false);
    expect(client.socket).toBeNull();
  });
});
