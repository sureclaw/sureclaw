import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { provisionScope } from '../../src/agent/workspace.js';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

describe('P1 fix: read-only scope locks directories', () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `ax-readonly-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Start a tiny HTTP server that returns workspace files including a subdirectory
    const files = [
      { path: 'top.txt', content_base64: Buffer.from('top-level').toString('base64'), size: 9 },
      { path: 'subdir/nested.txt', content_base64: Buffer.from('nested-file').toString('base64'), size: 11 },
      { path: 'subdir/deep/bottom.txt', content_base64: Buffer.from('deep').toString('base64'), size: 4 },
    ];
    const payload = gzipSync(Buffer.from(JSON.stringify({ files })));

    server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => {
    server.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('readOnly=true locks files to 0444 and directories to 0555', async () => {
    const mountPath = join(tmpDir, 'agent');
    const result = await provisionScope(mountPath, '', true, {
      hostUrl: `http://127.0.0.1:${port}`,
      scope: 'agent',
      id: 'main',
    });

    expect(result.source).toBe('gcs');
    expect(result.fileCount).toBe(3);

    // Files should be read-only (0444)
    const fileStat = statSync(join(mountPath, 'top.txt'));
    expect(fileStat.mode & 0o777).toBe(0o444);

    const nestedFileStat = statSync(join(mountPath, 'subdir', 'nested.txt'));
    expect(nestedFileStat.mode & 0o777).toBe(0o444);

    // Directories should be locked (0555) — no write bits
    const subdirStat = statSync(join(mountPath, 'subdir'));
    expect(subdirStat.mode & 0o777).toBe(0o555);

    const deepDirStat = statSync(join(mountPath, 'subdir', 'deep'));
    expect(deepDirStat.mode & 0o777).toBe(0o555);

    // Root mount should also be locked
    const rootStat = statSync(mountPath);
    expect(rootStat.mode & 0o777).toBe(0o555);
  });

  test('readOnly=false leaves directories writable', async () => {
    const mountPath = join(tmpDir, 'writable');
    const result = await provisionScope(mountPath, '', false, {
      hostUrl: `http://127.0.0.1:${port}`,
      scope: 'user',
      id: 'alice',
    });

    expect(result.source).toBe('gcs');

    // Directories should retain write bits
    const subdirStat = statSync(join(mountPath, 'subdir'));
    expect(subdirStat.mode & 0o200).not.toBe(0);
  });
});

describe('P1 fix: HTTP GCS path provisions git workspace', () => {
  test('runner.ts provisions git workspace inside HTTP GCS block', () => {
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    // The HTTP GCS branch (hostUrl && workspaceProvider === 'gcs') must also
    // handle workspaceGitUrl before returning, not skip it.
    const httpGcsBranch = source.indexOf("if (hostUrl && payload.workspaceProvider === 'gcs')");
    const earlyReturn = source.indexOf('return;', httpGcsBranch);
    const gitInHttpBlock = source.indexOf('payload.workspaceGitUrl', httpGcsBranch);
    // Git provisioning should appear BEFORE the early return in the HTTP GCS block
    expect(gitInHttpBlock).toBeGreaterThan(httpGcsBranch);
    expect(gitInHttpBlock).toBeLessThan(earlyReturn);
  });
});

describe('P1 fix: workspace provision validates scope IDs against token context', () => {
  test('provision endpoint validates id against provisionIds', () => {
    const source = readFileSync(resolve('src/host/host-process.ts'), 'utf-8');
    // The provision endpoint must check entry.provisionIds[scope] against id
    expect(source).toContain('entry.provisionIds');
    expect(source).toContain('Scope ID does not match token context');
  });

  test('activeTokens.set includes provisionIds with agent, user, session', () => {
    const source = readFileSync(resolve('src/host/host-process.ts'), 'utf-8');
    // Token registration must store provisionIds
    expect(source).toContain('provisionIds:');
    expect(source).toContain('agent: agentName');
    // userId and sessionId must also be stored for validation
    const setIdx = source.indexOf('activeTokens.set(turnToken');
    const provisionIdsIdx = source.indexOf('provisionIds:', setIdx);
    expect(provisionIdsIdx).toBeGreaterThan(setIdx);
    // The provisionIds should contain all three scope identifiers
    const blockEnd = source.indexOf('});', provisionIdsIdx);
    const block = source.slice(provisionIdsIdx, blockEnd);
    expect(block).toContain('session: sessionId');
  });

  test('provision endpoint returns 403 on id mismatch', () => {
    const source = readFileSync(resolve('src/host/host-process.ts'), 'utf-8');
    // The endpoint should return 403 when the id doesn't match
    expect(source).toContain("sendError(res, 403, 'Scope ID does not match token context')");
    expect(source).toContain('workspace_provision_id_mismatch');
  });
});
