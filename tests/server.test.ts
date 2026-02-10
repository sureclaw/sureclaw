import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type AxServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('Server', () => {
  let server: AxServer;
  let socketPath: string;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-test-${randomUUID()}.sock`);
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  });

  it('should start server on Unix socket', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    expect(server.listening).toBe(true);
  });

  it('should remove stale socket on startup', async () => {
    // Create a stale socket file
    const { writeFileSync } = await import('node:fs');
    writeFileSync(socketPath, '');

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    expect(server.listening).toBe(true);
  });

  it('should stop server gracefully', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    await server.stop();
    expect(server.listening).toBe(false);
  });
});
