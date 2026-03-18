import { describe, test, expect, vi } from 'vitest';
import { screenReleaseChanges } from '../../src/host/workspace-release-screener.js';
import type { WorkspaceChange, ScreeningOptions } from '../../src/host/workspace-release-screener.js';

const mockAudit = {
  log: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
};

const mockScreener = {
  screen: vi.fn().mockResolvedValue({ allowed: true, reasons: [] }),
  screenExtended: vi.fn().mockResolvedValue({
    verdict: 'APPROVE', score: 0, reasons: [], permissions: [], excessPermissions: [],
  }),
};

function makeOpts(overrides?: Partial<ScreeningOptions>): ScreeningOptions {
  return { screener: mockScreener as any, audit: mockAudit as any, sessionId: 'test', ...overrides };
}

describe('screenReleaseChanges', () => {
  test('passes clean skill files', async () => {
    const changes: WorkspaceChange[] = [
      { scope: 'user', path: 'skills/deploy.md', type: 'added', content: Buffer.from('# Deploy\nDeploy to prod'), size: 25 },
    ];
    const result = await screenReleaseChanges(changes, makeOpts());
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });

  test('rejects skill files that fail screening', async () => {
    const maliciousScreener = {
      screenExtended: vi.fn().mockResolvedValue({
        verdict: 'REJECT', score: 1,
        reasons: [{ category: 'exfil', severity: 'BLOCK', detail: 'data exfil detected' }],
      }),
    };
    const changes: WorkspaceChange[] = [
      { scope: 'user', path: 'skills/evil.md', type: 'added', content: Buffer.from('# Evil\nexfiltrate data'), size: 20 },
    ];
    const result = await screenReleaseChanges(changes, makeOpts({ screener: maliciousScreener as any }));
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('exfil');
  });

  test('rejects binaries exceeding size limit', async () => {
    const changes: WorkspaceChange[] = [
      { scope: 'user', path: 'bin/huge-binary', type: 'added', content: Buffer.alloc(1024), size: 200 * 1024 * 1024 },
    ];
    const result = await screenReleaseChanges(changes, makeOpts({ maxBinarySize: 100 * 1024 * 1024 }));
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('size');
  });

  test('passes non-skill non-binary files without screening', async () => {
    const changes: WorkspaceChange[] = [
      { scope: 'user', path: 'docs/notes.md', type: 'added', content: Buffer.from('hello'), size: 5 },
    ];
    const result = await screenReleaseChanges(changes, makeOpts());
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });

  test('passes deleted files without screening', async () => {
    const changes: WorkspaceChange[] = [
      { scope: 'user', path: 'skills/old.md', type: 'deleted', size: 0 },
    ];
    const result = await screenReleaseChanges(changes, makeOpts());
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });

  test('passes binaries under size limit', async () => {
    const changes: WorkspaceChange[] = [
      { scope: 'user', path: 'bin/small-tool', type: 'added', content: Buffer.alloc(1024), size: 1024 },
    ];
    const result = await screenReleaseChanges(changes, makeOpts());
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });

  test('works without screener (skills pass through)', async () => {
    const changes: WorkspaceChange[] = [
      { scope: 'user', path: 'skills/deploy.md', type: 'added', content: Buffer.from('# Deploy\nDeploy to prod'), size: 25 },
    ];
    const result = await screenReleaseChanges(changes, makeOpts({ screener: undefined }));
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
  });
});
