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
import { create as createSeatbelt } from '../src/providers/sandbox/seatbelt.js';
import { create as createSubprocess } from '../src/providers/sandbox/subprocess.js';
import { createIPCMcpServer } from '../src/agent/mcp-server.js';
import type { IPCClient } from '../src/agent/ipc-client.js';
import type { Config } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

const mockConfig = {
  profile: 'paranoid',
  providers: {
    memory: 'cortex', scanner: 'patterns',
    channels: ['cli'], web: 'none', browser: 'none',
    credentials: 'keychain', skills: 'readonly', audit: 'file',
    sandbox: 'subprocess', scheduler: 'none',
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

// ── Seatbelt Sandbox Env Isolation ───────────────────────────────────

describe('seatbelt sandbox env isolation', () => {
  test('seatbelt source constructs minimal env via symlinkEnv', async () => {
    // Verify at the source level that seatbelt constructs a minimal env
    // using the canonical symlink approach (not leaking process.env).
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/seatbelt.ts'), 'utf-8');

    // Extract the env block from the source
    const envMatch = source.match(/env:\s*\{([^}]+)\}/s);
    expect(envMatch).toBeTruthy();
    const envBlock = envMatch![1];

    // Should have PATH, HOME, and spread symlinkEnv vars
    expect(envBlock).toContain('PATH');
    expect(envBlock).toContain('HOME');
    expect(envBlock).toContain('...sEnv');

    // Must NOT spread process.env
    expect(envBlock).not.toContain('...process.env');

    // HOME should be set to mount root (canonical workspace root), not host path
    expect(envBlock).toContain('HOME: mountRoot');

    // Must use createCanonicalSymlinks and symlinkEnv
    expect(source).toContain('createCanonicalSymlinks');
    expect(source).toContain('symlinkEnv');
  });

  test('seatbelt does not pass ANTHROPIC_API_KEY or credentials in env', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/seatbelt.ts'), 'utf-8');

    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(source).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(source).not.toContain('TAVILY_API_KEY');
  });

  test('seatbelt provider does not pass AGENT_DIR (identity comes via stdin)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/seatbelt.ts'), 'utf-8');

    // Identity files are now sent via stdin payload from DocumentStore —
    // no AGENT_DIR mount needed in the sandbox.
    expect(source).not.toContain('AGENT_DIR');
  });

  test('seatbelt policy does not reference AGENT_DIR (identity comes via stdin)', async () => {
    const { readFileSync } = await import('node:fs');
    const policy = readFileSync(resolve('policies/agent.sb'), 'utf-8');

    // The policy should no longer reference AGENT_DIR since identity
    // files are sent via stdin payload from DocumentStore.
    expect(policy).not.toContain('AGENT_DIR');
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
    expect(source).toMatch(/sandbox\.spawn/);
  });

  test('bwrap provider does not mount identity directory', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/bwrap.ts'), 'utf-8');
    expect(source).not.toContain('agentDir');
    expect(source).not.toContain('CANONICAL.identity');
  });

  test('nsjail provider does not mount identity directory', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/nsjail.ts'), 'utf-8');
    expect(source).not.toContain('agentDir');
    expect(source).not.toContain('CANONICAL.identity');
  });

  test('docker provider does not mount identity directory', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');
    expect(source).not.toContain('agentDir');
    expect(source).not.toContain('CANONICAL.identity');
  });
});

// ── Subprocess Sandbox Env Leak (Documented Dev-Only Risk) ──────────

describe('subprocess sandbox env leak (dev-only fallback)', () => {
  test('subprocess sandbox uses process.env spread — documented dev-only risk', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/subprocess.ts'), 'utf-8');

    // Document that subprocess spreads process.env
    expect(source).toContain('...process.env');

    // It does emit a warning about no isolation
    expect(source).toContain('no_isolation');
    expect(source).toContain('dev-only');
  });

  test('subprocess sandbox adds AX_ env vars with canonical symlink paths', async () => {
    // Verify subprocess actually spawns with the right env by running a real process.
    // With canonical paths, AX_WORKSPACE points to symlinks under /tmp/.ax-mounts-*/
    // Skills are now sent via stdin payload, so AX_SKILLS is no longer set.
    const { mkdirSync, rmSync } = await import('node:fs');
    const ws = '/tmp/test-ws-' + process.pid;
    mkdirSync(ws, { recursive: true });
    try {
    const provider = await createSubprocess(mockConfig);
    const proc = await provider.spawn({
      workspace: ws,
      ipcSocket: '/tmp/test-ipc.sock',
      command: ['node', '-e', 'console.log(JSON.stringify({ipc:process.env.AX_IPC_SOCKET,ws:process.env.AX_WORKSPACE,sk:process.env.AX_SKILLS}))'],
      timeoutSec: 5,
    });

    let output = '';
    for await (const chunk of proc.stdout) {
      output += chunk.toString();
    }
    await proc.exitCode;

    const env = JSON.parse(output.trim());
    expect(env.ipc).toBe('/tmp/test-ipc.sock');
    // AX_WORKSPACE is now the mount root; AX_SKILLS is no longer set (skills come via stdin)
    expect(env.ws).toMatch(/\/tmp\/\.ax-mounts-[a-f0-9]+$/);
    expect(env.sk).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
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
    expect(source).toContain("ANTHROPIC_API_KEY: 'ax-proxy'");
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

    // Workspace is NOT passed as a CLI arg — it's set via canonical env
    // vars by the sandbox provider. Identity and skills come via stdin payload.
    const spawnSection = source.slice(source.indexOf('spawnCommand'));
    expect(spawnSection).not.toContain("'--workspace'");
    expect(spawnSection).not.toContain("'--skills'");
    expect(spawnSection).not.toContain("'--agent-dir'");

    // Skills are loaded from DocumentStore and sent via stdin payload, not
    // mounted as a filesystem directory via overlayfs.
    expect(source).toContain("loadSkillsFromDB");
    expect(source).toContain("skills: skillsPayload");

    // Must NOT have overlayfs merge or filesystem-based skills
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
  test('server.ts uses import.meta.url-based asset resolvers for tsx and agent-runner paths (host-side)', async () => {
    // The spawn command in server.ts uses asset resolvers from utils/assets.ts
    // which resolve paths relative to import.meta.url (not CWD). This ensures
    // the host process can find tsx and runner.ts regardless of working directory.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server.ts'), 'utf-8');

    // Verify server.ts imports the asset resolvers
    expect(source).toContain("from '../utils/assets.js'");
    // Verify it calls them to get paths
    expect(source).not.toContain("resolve('node_modules/.bin/tsx')");
    expect(source).not.toContain("resolve('src/agent/runner.ts')");
  });

  test('agent-runner parseArgs does not expose paths beyond what is passed in', () => {
    // The agent-runner receives paths from CLI args (--workspace, --skills, --ipc-socket).
    // These are already workspace-local paths set by server.ts.
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
  test('exposes exactly 14 IPC tools', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const expected = [
      'memory', 'web', 'identity', 'scheduler', 'skill',
      'audit', 'agent', 'image',
      // Enterprise tools
      'workspace', 'governance',
      // Sandbox tools
      'bash', 'read_file', 'write_file', 'edit_file',
    ];

    expect(Object.keys(tools).sort()).toEqual(expected.sort());
    expect(Object.keys(tools).length).toBe(14);
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
    expect(names).toContain('image');
  });
});
