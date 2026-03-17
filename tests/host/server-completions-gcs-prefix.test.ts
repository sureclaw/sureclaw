/**
 * Regression tests: workspace GCS prefixes in the work payload must be derived
 * from config.workspace.prefix (same source as gcs.ts createRemoteTransport),
 * not only from the AX_WORKSPACE_GCS_PREFIX env var.
 *
 * Without this fix, provisioning was skipped when config.workspace.prefix was
 * set but the env var wasn't — leaving the agent with a blank filesystem even
 * though files were already committed to GCS.
 *
 * Additional bugs fixed:
 *  - Empty-string prefix (the gcs.ts default) was treated as "not configured"
 *    so provisioning was skipped for the common no-prefix case.
 *  - A prefix without a trailing slash produced malformed GCS paths
 *    (e.g. "myappscratch/..." instead of "myapp/scratch/...").
 */

import { describe, test, expect, afterEach } from 'vitest';
import { resolveWorkspaceGcsPrefixes } from '../../src/host/server-completions.js';
import type { Config } from '../../src/types.js';

function makeConfig(overrides: {
  workspaceProvider?: string;
  workspacePrefix?: string | null;  // null = omit from config entirely
} = {}): Config {
  const provider = overrides.workspaceProvider ?? 'gcs';
  return {
    providers: { sandbox: 'k8s', workspace: provider },
    workspace: overrides.workspacePrefix === null
      ? undefined
      : { prefix: overrides.workspacePrefix ?? undefined },
  } as unknown as Config;
}

describe('resolveWorkspaceGcsPrefixes', () => {
  afterEach(() => {
    delete process.env.AX_WORKSPACE_GCS_PREFIX;
  });

  // ── gcs provider with explicit prefix ──────────────────────────────

  test('uses config.workspace.prefix when set', () => {
    const result = resolveWorkspaceGcsPrefixes(
      makeConfig({ workspacePrefix: 'myapp/' }),
      'assistant', 'user42', 'sess-1',
    );
    expect(result.agentGcsPrefix).toBe('myapp/agent/assistant/');
    expect(result.userGcsPrefix).toBe('myapp/user/user42/');
    expect(result.sessionGcsPrefix).toBe('myapp/scratch/sess-1/');
  });

  test('normalises prefix without trailing slash', () => {
    // 'myapp' (no slash) must produce 'myapp/agent/...' not 'myappagent/...'
    const result = resolveWorkspaceGcsPrefixes(
      makeConfig({ workspacePrefix: 'myapp' }),
      'assistant', 'user42', 'sess-1',
    );
    expect(result.agentGcsPrefix).toBe('myapp/agent/assistant/');
    expect(result.sessionGcsPrefix).toBe('myapp/scratch/sess-1/');
  });

  // ── gcs provider with empty / absent prefix ─────────────────────────

  test('produces prefixes for empty-string prefix (bucket root)', () => {
    // Empty prefix is the gcs.ts default — files live at scratch/{id}/ directly.
    const result = resolveWorkspaceGcsPrefixes(
      makeConfig({ workspacePrefix: '' }),
      'assistant', 'user42', 'sess-1',
    );
    expect(result.agentGcsPrefix).toBe('agent/assistant/');
    expect(result.userGcsPrefix).toBe('user/user42/');
    expect(result.sessionGcsPrefix).toBe('scratch/sess-1/');
  });

  test('produces prefixes when config.workspace has no prefix field', () => {
    // No prefix field → same as empty string (bucket root).
    // The env var fallback resolves to '' here too.
    const result = resolveWorkspaceGcsPrefixes(
      makeConfig({ workspacePrefix: undefined }),
      'assistant', 'user42', 'sess-1',
    );
    expect(result.sessionGcsPrefix).toBe('scratch/sess-1/');
  });

  test('produces prefixes when workspace section is absent', () => {
    // config.workspace === undefined → rawPrefix falls through to '' default.
    const result = resolveWorkspaceGcsPrefixes(
      makeConfig({ workspacePrefix: null }),
      'assistant', 'user42', 'sess-1',
    );
    expect(result.sessionGcsPrefix).toBe('scratch/sess-1/');
  });

  // ── env var fallback ────────────────────────────────────────────────

  test('falls back to AX_WORKSPACE_GCS_PREFIX env var when config prefix is absent', () => {
    process.env.AX_WORKSPACE_GCS_PREFIX = 'envapp/';
    const result = resolveWorkspaceGcsPrefixes(
      makeConfig({ workspacePrefix: null }),
      'assistant', 'user42', 'sess-1',
    );
    expect(result.agentGcsPrefix).toBe('envapp/agent/assistant/');
    expect(result.userGcsPrefix).toBe('envapp/user/user42/');
    expect(result.sessionGcsPrefix).toBe('envapp/scratch/sess-1/');
  });

  test('config.workspace.prefix takes precedence over env var', () => {
    process.env.AX_WORKSPACE_GCS_PREFIX = 'envapp/';
    const result = resolveWorkspaceGcsPrefixes(
      makeConfig({ workspacePrefix: 'configapp/' }),
      'assistant', 'user42', 'sess-1',
    );
    expect(result.agentGcsPrefix).toBe('configapp/agent/assistant/');
    expect(result.sessionGcsPrefix).toBe('configapp/scratch/sess-1/');
  });

  // ── non-gcs providers must return empty ────────────────────────────

  test('returns empty object for non-gcs workspace provider', () => {
    expect(resolveWorkspaceGcsPrefixes(
      makeConfig({ workspaceProvider: 'none' }),
      'assistant', 'user42', 'sess-1',
    )).toEqual({});

    expect(resolveWorkspaceGcsPrefixes(
      makeConfig({ workspaceProvider: 'local' }),
      'assistant', 'user42', 'sess-1',
    )).toEqual({});
  });
});
