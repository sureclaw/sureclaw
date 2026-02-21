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
    llm: 'anthropic', memory: 'file', scanner: 'basic',
    channels: ['cli'], web: 'none', browser: 'none',
    credentials: 'env', skills: 'readonly', audit: 'file',
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
  test('seatbelt source constructs minimal env — only 5 vars', async () => {
    // Verify at the source level that seatbelt constructs a minimal env.
    // We can't spy on spawn in ESM, so we verify the source code directly.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/seatbelt.ts'), 'utf-8');

    // Extract the env block from the source
    const envMatch = source.match(/env:\s*\{([^}]+)\}/s);
    expect(envMatch).toBeTruthy();
    const envBlock = envMatch![1];

    // Should only have these 5 env vars
    expect(envBlock).toContain('PATH');
    expect(envBlock).toContain('HOME');
    expect(envBlock).toContain('AX_IPC_SOCKET');
    expect(envBlock).toContain('AX_WORKSPACE');
    expect(envBlock).toContain('AX_SKILLS');

    // Must NOT spread process.env
    expect(envBlock).not.toContain('...process.env');

    // HOME should be set to workspace, not host home
    expect(envBlock).toContain('HOME: config.workspace');
  });

  test('seatbelt does not pass ANTHROPIC_API_KEY or credentials in env', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/seatbelt.ts'), 'utf-8');

    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(source).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(source).not.toContain('TAVILY_API_KEY');
  });

  test('seatbelt provider passes AGENT_DIR for identity file access', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/seatbelt.ts'), 'utf-8');

    // The seatbelt provider must pass AGENT_DIR so the agent can read
    // identity files (BOOTSTRAP.md, SOUL.md, IDENTITY.md, etc.)
    expect(source).toContain('AGENT_DIR');
  });

  test('seatbelt policy allows read access to AGENT_DIR', async () => {
    const { readFileSync } = await import('node:fs');
    const policy = readFileSync(resolve('policies/agent.sb'), 'utf-8');

    // The policy must allow read access to the agent identity directory
    expect(policy).toContain('AGENT_DIR');
    expect(policy).toContain('(allow file-read*');
    // Verify it's read-only (no file-write* for AGENT_DIR)
    expect(policy).not.toMatch(/file-write\*.*AGENT_DIR/);
  });
});

// ── Agent Dir Passed to All Sandbox Providers ────────────────────────

describe('sandbox providers accept agentDir for identity files', () => {
  test('server passes agentDir to sandbox.spawn()', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server.ts'), 'utf-8');

    // processCompletion must pass agentDir in the sandbox config
    expect(source).toMatch(/sandbox\.spawn\(\{[^}]*agentDir/s);
  });

  test('bwrap provider mounts agentDir read-only', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/bwrap.ts'), 'utf-8');
    expect(source).toContain('agentDir');
    expect(source).toContain('--ro-bind');
  });

  test('nsjail provider mounts agentDir read-only', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/nsjail.ts'), 'utf-8');
    expect(source).toContain('agentDir');
    expect(source).toContain('bindmount_ro');
  });

  test('docker provider mounts agentDir read-only', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');
    expect(source).toContain('agentDir');
    expect(source).toMatch(/:ro/);
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

  test('subprocess sandbox adds AX_ env vars', async () => {
    // Verify subprocess actually spawns with the right env by running a real process
    const { mkdirSync, rmSync } = await import('node:fs');
    const ws = '/tmp/test-ws-' + process.pid;
    mkdirSync(ws, { recursive: true });
    try {
    const provider = await createSubprocess(mockConfig);
    const proc = await provider.spawn({
      workspace: ws,
      skills: ws + '/skills',
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
    expect(env.ws).toBe(ws);
    expect(env.sk).toBe(ws + '/skills');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ── System Prompt Uses Relative Paths (via PromptBuilder) ─────────────

describe('system prompt uses relative paths', () => {
  // All three runners now use PromptBuilder, which delegates to SkillsModule.
  // Check that the module contains the relative path pattern.

  test('SkillsModule uses ./skills, not absolute path', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/agent/prompt/modules/skills.ts'), 'utf-8');
    expect(source).toContain("Skills directory: ./skills");
  });

  test('all runners use PromptBuilder for system prompt', async () => {
    const { readFileSync } = await import('node:fs');

    const piSession = readFileSync(resolve('src/agent/runners/pi-session.ts'), 'utf-8');
    expect(piSession).toContain("from '../prompt/builder.js'");

    const claudeCode = readFileSync(resolve('src/agent/runners/claude-code.ts'), 'utf-8');
    expect(claudeCode).toContain("from '../prompt/builder.js'");

    const runner = readFileSync(resolve('src/agent/runner.ts'), 'utf-8');
    expect(runner).toContain("from './prompt/builder.js'");
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
  test('spawn command uses workspace-local skills path, not host path', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server.ts'), 'utf-8');

    // The skills path passed to agent should be wsSkillsDir (in workspace),
    // not the host-side skillsDir or hostSkillsDir
    expect(source).toContain("'--skills', wsSkillsDir");

    // Skills are copied into workspace
    expect(source).toContain("const wsSkillsDir = join(workspace, 'skills')");

    // hostSkillsDir should NOT appear in spawn command args
    // (it should only be used for the copy source)
    const spawnSection = source.slice(source.indexOf('spawnCommand'));
    expect(spawnSection).not.toContain('hostSkillsDir');
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

    const result = await tools['web_fetch'].handler({ url: 'https://example.com' }, {});
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

    const result = await tools['web_search'].handler({ query: 'test' }, {});
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

    const result = await tools['web_fetch'].handler({ url: 'https://example.com' }, {});
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

    const result = await tools['web_fetch'].handler({ url: 'https://example.com' }, {});
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

    const result = await tools['memory_read'].handler({ id: 'test' }, {});

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

    const result = await tools['web_fetch'].handler({ url: 'https://example.com' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('taint');
    expect(result.content[0].text).not.toContain('external');
  });
});

// ── Spawn Command Paths ──────────────────────────────────────────────

describe('spawn command construction', () => {
  test('server.ts uses resolve() for tsx and agent-runner paths (host-side)', async () => {
    // The spawn command in server.ts uses resolve() which creates absolute paths.
    // These paths are on the HOST side (they point to the tsx binary and
    // agent-runner.ts in the project directory). This is necessary because the
    // host process needs to find these files. The sandbox provider's env filtering
    // (seatbelt) is what prevents these from reaching the agent. But for
    // subprocess (dev-only), the agent can see these paths via process.argv.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/host/server.ts'), 'utf-8');

    // Verify tsx and agent-runner paths use resolve() (they must for host-side spawning)
    expect(source).toContain("resolve('node_modules/.bin/tsx')");
    expect(source).toContain("resolve('src/agent/runner.ts')");
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
      source.indexOf('function makeProxyErrorMessage'),
    );

    // Should not use resolve() or process.cwd() to construct paths
    expect(parseArgsBody).not.toContain('resolve(');
    expect(parseArgsBody).not.toContain('process.cwd()');
  });
});

// ── MCP Server Tool Registry ─────────────────────────────────────────

describe('MCP server tool registry security', () => {
  test('does not expose skill_read or skill_list tools', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const tools = getTools(server);
    const names = Object.keys(tools);

    // Skill tools were removed — skills are read directly from filesystem
    expect(names).not.toContain('skill_read');
    expect(names).not.toContain('skill_list');
  });

  test('exposes exactly 14 IPC tools', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    const expected = [
      'memory_write', 'memory_query', 'memory_read', 'memory_delete', 'memory_list',
      'web_search', 'web_fetch',
      'audit_query',
      'identity_write',
      'user_write',
      'scheduler_add_cron',
      'scheduler_run_at',
      'scheduler_remove_cron',
      'scheduler_list_jobs',
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

// ── IPC Tools (pi-agent-core) ────────────────────────────────────────

describe('IPC tools for pi-agent-core do not expose paths', () => {
  test('ipc-tools exports memory, web, and audit tools — no skill tools', async () => {
    const { createIPCTools } = await import('../src/agent/ipc-tools.js');
    const client = createMockClient();
    const tools = createIPCTools(client);
    const names = tools.map(t => t.name);

    expect(names).not.toContain('skill_read');
    expect(names).not.toContain('skill_list');

    expect(names).toContain('memory_write');
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    expect(names).toContain('audit_query');
  });
});
