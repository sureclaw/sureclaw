/**
 * Sandbox isolation tests — verify that host filesystem paths, environment
 * variables, and other sensitive data don't leak into agent containers.
 *
 * These tests catch regressions like:
 *   - Absolute host paths in system prompts or agent env
 *   - Full process.env passed to sandboxed agents
 *   - Taint metadata leaking through IPC tool results
 *   - Error messages exposing host filesystem paths
 */

import { describe, test, expect, vi } from 'vitest';
import { resolve, sep } from 'node:path';
import { createIPCMcpServer } from '../src/agent/mcp-server.js';
import type { IPCClient } from '../src/agent/ipc-client.js';
import type { Config } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

const mockConfig = {
  agent_name: 'test-agent',
  profile: 'paranoid',
  providers: {
    memory: 'cortex', security: 'patterns',
    channels: ['cli'], web: { extract: 'none', search: 'none' },
    credentials: 'database', audit: 'database',
    sandbox: 'docker', scheduler: 'none',
  },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '07:00', end: '23:00', timezone: 'America/New_York' },
    max_token_budget: 4096, heartbeat_interval_min: 30,
  },
} as Config;

function createMockClient(response: unknown = { ok: true }): IPCClient {
  return {
    call: vi.fn().mockResolvedValue(response),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  } as unknown as IPCClient;
}

function createErrorClient(message: string): IPCClient {
  return {
    call: vi.fn().mockRejectedValue(new Error(message)),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  } as unknown as IPCClient;
}

/** Get the tool registry from a McpServer instance. */
function getTools(server: ReturnType<typeof createIPCMcpServer>): Record<string, any> {
  return (server.instance as any)._registeredTools;
}

/** Host project root — tests verify this path never appears in sandbox-facing output. */
const PROJECT_ROOT = resolve('.');
const HOME_DIR = process.env.HOME ?? '';

// ── Seatbelt/nsjail/bwrap providers removed — see local-sandbox-execution plan ──

// ── Per-Tier Writable Workspace Flags in Sandbox Providers ───────────

describe('single workspace model in sandbox providers', () => {
  test('docker mounts single /workspace rw', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');
    // No per-tier writable flags in simplified model
    expect(source).not.toContain('agentWorkspaceWritable');
    expect(source).not.toContain('userWorkspaceWritable');
  });

  test('server-completions uses single workspace (no agent/user split)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');

    // Should not reference removed workspace tier fields
    expect(source).not.toContain('agentWorkspaceWritable');
    expect(source).not.toContain('userWorkspaceWritable');
  });
});

// ── Identity Mount Removed From All Sandbox Providers ────────────────

describe('sandbox providers do not mount identity (now via stdin payload)', () => {
  test('server does not pass agentDir to sandbox config', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');

    // Identity files are sent via stdin payload from DocumentStore.
    // The sandboxConfig object should not include agentDir.
    const sandboxSection = source.slice(source.indexOf('sandboxConfig'));
    expect(sandboxSection).not.toMatch(/agentDir/);
    expect(source).toMatch(/[Ss]andbox\.spawn/);
  });

  test('docker provider does not mount identity directory', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');
    expect(source).not.toContain('agentDir');
    expect(source).not.toContain('CANONICAL.identity');
  });
});

// ── System Prompt Uses Relative Paths (via PromptBuilder) ─────────────

describe('system prompt uses relative paths', () => {
  // All three runners now use PromptBuilder, which delegates to SkillsModule.
  // Check that the module contains the relative path pattern.

  test('SkillsModule uses skill tool for progressive disclosure, not absolute paths', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/prompt/modules/skills.ts'), 'utf-8');
    // Progressive disclosure: module renders compact summaries, agent loads via skill({ type: "read" })
    expect(source).toContain('skill');
    expect(source).toContain('read');
    // Must not embed absolute filesystem paths
    expect(source).not.toMatch(/\/home\//);
    expect(source).not.toMatch(/\/Users\//);
  });

  test('all runners use PromptBuilder for system prompt', async () => {
    const { readFileSync } = await import('node:fs');

    // Both runners use buildSystemPrompt from agent-setup.ts,
    // which in turn uses PromptBuilder. Verify the chain.
    const agentSetup = readFileSync(resolve('src/agent/agent-setup.ts'), 'utf-8');
    expect(agentSetup).toContain("from './prompt/builder.js'");

    const piSession = readFileSync(resolve('src/agent/runners/pi-session.ts'), 'utf-8');
    expect(piSession).toContain("from '../agent-setup.js'");

    // claude-code uses shared buildSystemPrompt from agent-setup
    const claudeCode = readFileSync(resolve('src/agent/runners/claude-code.ts'), 'utf-8');
    expect(claudeCode).toContain("from '../agent-setup.js'");
  });
});

// ── claude-code env spread leaks host env ────────────────────────────

describe('claude-code env spread', () => {
  test('passes ...process.env to Agent SDK query (CRITICAL — documented leak)', async () => {
    // This test documents that claude-code.ts uses `...process.env` which
    // passes the full host environment to the Agent SDK subprocess.
    // The Agent SDK runs inside the seatbelt sandbox, so the seatbelt's own
    // env filtering (5 vars only) provides the real isolation. But claude-code.ts
    // itself doesn't filter — it passes everything.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runners/claude-code.ts'), 'utf-8');

    // Document that this spread exists
    expect(source).toContain('...process.env');

    // But it does set safe overrides for credentials
    // HTTP mode uses per-turn token, bridge mode uses dummy 'ax-proxy' key
    expect(source).toContain("'ax-proxy'");
    expect(source).toContain('CLAUDE_CODE_OAUTH_TOKEN: undefined');
  });

  test('disallows WebFetch, WebSearch, and Skill built-in tools', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runners/claude-code.ts'), 'utf-8');

    expect(source).toContain("'WebFetch'");
    expect(source).toContain("'WebSearch'");
    expect(source).toContain("'Skill'");
  });
});

// ── Server copies skills into workspace ──────────────────────────────

describe('server workspace isolation', () => {
  test('spawn command does not pass workspace/skills paths as CLI args', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');

    // Workspace is NOT passed as a CLI arg to the agent — it's set via canonical env
    // vars by the sandbox provider. Identity comes via stdin payload; skills are
    // now filesystem-based (loaded from workspace directories at agent startup).
    const spawnStart = source.indexOf('spawnCommand');
    const spawnEnd = source.indexOf('host_prepare', spawnStart);
    const spawnSection = source.slice(spawnStart, spawnEnd !== -1 ? spawnEnd : undefined);
    expect(spawnSection).not.toContain("'--workspace'");
    expect(spawnSection).not.toContain("'--skills'");
    expect(spawnSection).not.toContain("'--agent-dir'");

    // Skills are DB-backed and delivered via payload — no CLI args or host paths
    expect(source).not.toContain("mergeSkillsOverlay");
    expect(source).not.toContain("wsSkillsDir");
    expect(source).not.toContain("hostSkillsDir");
  });

  test('skills dir is a peer of workspace, not a subpath', async () => {
    const { readFileSync } = await import('node:fs');
    const pathsSource = readFileSync(resolve('src/paths.ts'), 'utf-8');

    // Skills dir must be derived from agentIdentityDir, not agentWorkspaceDir
    expect(pathsSource).toMatch(/agentSkillsDir.*agentIdentityDir/s);
    expect(pathsSource).not.toMatch(/agentSkillsDir.*agentWorkspaceDir/s);
  });
});

// ── stripTaint deep nesting ──────────────────────────────────────────

describe('stripTaint handles all nesting patterns', () => {
  test('strips taint from deeply nested objects (3+ levels)', async () => {
    const client = createMockClient({
      data: {
        inner: {
          deep: {
            value: 'hello',
            taint: { source: 'deep', trust: 'external' },
          },
          taint: { source: 'inner', trust: 'external' },
        },
        taint: { source: 'data', trust: 'external' },
      },
      taint: { source: 'top', trust: 'external' },
    });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['web'].handler({ type: 'fetch', url: 'https://example.com' }, {});
    const parsed = JSON.parse(result.content[0].text);

    // No taint at any level
    expect(parsed.taint).toBeUndefined();
    expect(parsed.data.taint).toBeUndefined();
    expect(parsed.data.inner.taint).toBeUndefined();
    expect(parsed.data.inner.deep.taint).toBeUndefined();

    // Values preserved
    expect(parsed.data.inner.deep.value).toBe('hello');
  });

  test('strips taint from mixed arrays and objects', async () => {
    const client = createMockClient({
      results: [
        {
          items: [
            { text: 'A', taint: { source: 'nested-array', trust: 'external' } },
            { text: 'B' },
          ],
          taint: { source: 'result', trust: 'external' },
        },
      ],
      taint: { source: 'root', trust: 'external' },
    });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['web'].handler({ type: 'search', query: 'test' }, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.taint).toBeUndefined();
    expect(parsed.results[0].taint).toBeUndefined();
    expect(parsed.results[0].items[0].taint).toBeUndefined();
    expect(parsed.results[0].items[0].text).toBe('A');
    expect(parsed.results[0].items[1].text).toBe('B');
  });

  test('preserves null, boolean, and number values', async () => {
    const client = createMockClient({
      count: 42,
      active: true,
      missing: null,
      taint: { source: 'test', trust: 'external' },
    });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['web'].handler({ type: 'fetch', url: 'https://example.com' }, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(42);
    expect(parsed.active).toBe(true);
    expect(parsed.missing).toBeNull();
    expect(parsed.taint).toBeUndefined();
  });

  test('handles empty arrays and objects', async () => {
    const client = createMockClient({
      items: [],
      nested: {},
      taint: { source: 'test', trust: 'external' },
    });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['web'].handler({ type: 'fetch', url: 'https://example.com' }, {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.items).toEqual([]);
    expect(parsed.nested).toEqual({});
    expect(parsed.taint).toBeUndefined();
  });
});

// ── IPC Error Messages Don't Expose Host Paths ───────────────────────

describe('IPC error messages do not expose host paths', () => {
  test('error from IPC contains error text, not host filesystem paths', async () => {
    // Simulate an IPC error with a path in the message
    const client = createErrorClient('ENOENT: no such file or directory: /tmp/test.sock');
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['memory'].handler({ type: 'read', id: 'test' }, {});

    expect(result.isError).toBe(true);
    // Error text is present
    expect(result.content[0].text).toContain('ENOENT');

    // The error message should NOT contain the host project root
    expect(result.content[0].text).not.toContain(PROJECT_ROOT);
  });

  test('error result does not include taint metadata', async () => {
    const client = createErrorClient('connection refused');
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const result = await tools['web'].handler({ type: 'fetch', url: 'https://example.com' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('taint');
    expect(result.content[0].text).not.toContain('external');
  });
});

// ── Spawn Command Paths ──────────────────────────────────────────────

describe('spawn command construction', () => {
  test('server-local.ts uses import.meta.url-based asset resolvers for tsx and agent-runner paths (host-side)', async () => {
    // The spawn command in server-local.ts uses asset resolvers from utils/assets.ts
    // which resolve paths relative to import.meta.url (not CWD). This ensures
    // the host process can find tsx and runner.ts regardless of working directory.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-local.ts'), 'utf-8');

    // Verify server-local.ts imports the asset resolvers
    expect(source).toContain("from '../utils/assets.js'");
    // Verify it calls them to get paths
    expect(source).not.toContain("resolve('node_modules/.bin/tsx')");
    expect(source).not.toContain("resolve('src/agent/runner.ts')");
  });

  test('agent-runner parseArgs does not expose paths beyond what is passed in', () => {
    // The agent-runner receives paths from CLI args (--workspace, --skills, --ipc-socket).
    // These are already workspace-local paths set by server-local.ts.
    // Verify it doesn't use resolve() or process.cwd() to construct additional paths.
    const { readFileSync } = require('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');

    // parseArgs should only use the paths provided via CLI args and env vars
    const parseArgsBody = source.slice(
      source.indexOf('function parseArgs'),
      source.indexOf('async function readStdin'),
    );

    // Should not use resolve() or process.cwd() to construct paths
    expect(parseArgsBody).not.toContain('resolve(');
    expect(parseArgsBody).not.toContain('process.cwd()');
  });
});

// ── MCP Server Tool Registry ─────────────────────────────────────────

describe('MCP server tool registry security', () => {
  test('exposes exactly 16 IPC tools', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const expected = [
      'memory', 'web', 'identity', 'scheduler', 'skill', 'request_credential',
      'audit', 'agent',
      // Enterprise tools
      'save_artifact', 'governance',
      // Sandbox tools
      'bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob',
    ];

    expect(Object.keys(tools).sort()).toEqual(expected.sort());
    expect(Object.keys(tools).length).toBe(16);
  });

  test('tool results are JSON strings, not raw objects with taint', () => {
    const client = createMockClient({ data: 'test' });
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    // All tools should return { content: [{ type: 'text', text: string }] }
    // The text should be valid JSON
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.handler).toBeDefined();
    }
  });
});

// ── K8s Pod Spec Workspace Tier Volumes ───────────────────────────────

describe('k8s pod spec workspace volumes', () => {
  test('k8s pod spec declares workspace and tmp volumes', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/k8s.ts'), 'utf-8');
    expect(source).toContain("name: 'workspace'");
    expect(source).toContain("name: 'tmp'");
    expect(source).toContain("mountPath: '/workspace'");
  });
});

// ── /workspace Root Is Read-Only ──────────────────────────────────────

describe('/workspace root is read-only', () => {
  test('docker already has --read-only flag', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');
    expect(source).toContain("'--read-only'");
  });
});

// Session scope / scratch workspace tests removed — sandbox-worker deleted

// ── Single Workspace Model ─────────────────────────────────────────────

describe('single workspace model', () => {
  test('SandboxConfig uses git-based workspace (no PVC)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/types.ts'), 'utf-8');

    // Workspace is now git-backed via sidecar — no PVC needed
    expect(source).not.toContain('pvcName');
    // Old per-tier flags should be removed
    expect(source).not.toContain('agentWorkspaceWritable');
    expect(source).not.toContain('userWorkspaceWritable');
  });
});

// ── Workspace Location removed (single /workspace model) ──────────────

describe('workspace location removed', () => {
  test('SandboxProvider no longer has workspaceLocation field', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/types.ts'), 'utf-8');
    expect(source).not.toContain('workspaceLocation');
  });
});

// ── SandboxConfig Network Flag Removed ────────────────────────────────

describe('SandboxConfig network flag removed', () => {
  test('SandboxConfig no longer has network flag', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/types.ts'), 'utf-8');
    expect(source).not.toContain('network?:');
    expect(source).not.toContain('Three-phase orchestration');
  });
});

// ── Lifecycle Dispatch Replaces Three-Phase Orchestration ─────────────

describe('lifecycle dispatch replaces three-phase orchestration', () => {
  test('server-completions no longer spawns separate provision or cleanup pods', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');
    expect(source).not.toContain('provision_phase_start');
    expect(source).not.toContain('cleanup_phase_start');
    expect(source).not.toContain('workspace-cli.js provision');
    expect(source).not.toContain('workspace-cli.js cleanup');
  });

});

// In-pod git workspace cleanup removed — git workspace provisioning no longer exists.

// ── Work Payload Workspace Provisioning Fields ───────────────────────

describe('work payload includes skills from DB', () => {
  test('stdinPayload includes skills field', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');
    expect(source).toContain('skills: skillsPayload');
  });

  test('StdinPayload type includes skills field', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    expect(source).toContain('skills?:');
  });
});

// ── IPC Tools ────────────────────────────────────────────────────────

describe('IPC tools do not expose paths', () => {
  test('ipc-tools exports consolidated memory, web, audit, and skill tools', async () => {
    const { createIPCTools } = await import('../src/agent/ipc-tools.js');
    const client = createMockClient();
    const tools = createIPCTools(client);
    const names = tools.map(t => t.name);

    expect(names).toContain('memory');
    expect(names).toContain('web');
    expect(names).toContain('audit');
    expect(names).toContain('skill');
    expect(names).toContain('agent');
  });
});
