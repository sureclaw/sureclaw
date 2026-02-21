/**
 * Sync tests: verify the tool catalog stays in sync with consumers.
 *
 * - tool-catalog ↔ mcp-server: tool names and parameter keys match
 * - tool-catalog ↔ system prompt: every tool is documented in the
 *   appropriate prompt module so the LLM knows to use it
 * - tool-catalog ↔ IPC schemas: every tool has a Zod schema
 */

import { describe, test, expect, vi } from 'vitest';
import { TOOL_CATALOG, TOOL_NAMES, getToolParamKeys } from '../../src/agent/tool-catalog.js';
import { createIPCMcpServer } from '../../src/agent/mcp-server.js';
import { HeartbeatModule } from '../../src/agent/prompt/modules/heartbeat.js';
import { IdentityModule } from '../../src/agent/prompt/modules/identity.js';
import { IPC_SCHEMAS } from '../../src/ipc-schemas.js';
import type { PromptContext } from '../../src/agent/prompt/types.js';
import type { IPCClient } from '../../src/agent/ipc-client.js';

function createMockClient(): IPCClient {
  return {
    call: vi.fn().mockResolvedValue({ ok: true }),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  } as unknown as IPCClient;
}

function getTools(server: ReturnType<typeof createIPCMcpServer>): Record<string, any> {
  return (server.instance as any)._registeredTools;
}

describe('tool-catalog ↔ mcp-server sync', () => {
  test('MCP tool names exactly match TOOL_NAMES', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const mcpToolNames = Object.keys(getTools(server)).sort();
    const catalogNames = [...TOOL_NAMES].sort();
    expect(mcpToolNames).toEqual(catalogNames);
  });

  test('each MCP tool parameter keys match catalog getToolParamKeys', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    for (const name of TOOL_NAMES) {
      const mcpTool = tools[name];
      expect(mcpTool, `MCP tool "${name}" not found`).toBeDefined();

      // Extract Zod schema keys from the MCP tool's inputSchema
      // Zod v4 stores shape at inputSchema.def.shape
      const zodShape = mcpTool.inputSchema?.def?.shape ?? {};
      const mcpKeys = Object.keys(zodShape).sort();
      const catalogKeys = getToolParamKeys(name).sort();

      expect(mcpKeys, `Parameter keys mismatch for tool "${name}"`).toEqual(catalogKeys);
    }
  });
});

// ── tool-catalog ↔ system prompt sync ────────────────────────────────
//
// Tools registered in the API's tools[] are only half the story.
// The system prompt must ALSO document each tool so the LLM knows
// when and how to use it. Without prompt guidance, models hallucinate
// the behavior instead of calling the tool.

function makePromptContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp',
    skills: [],
    profile: 'balanced',
    sandboxType: 'subprocess',
    taintRatio: 0,
    taintThreshold: 0.10,
    identityFiles: {
      agents: '', soul: 'I am a test agent', identity: '', user: '',
      bootstrap: '', userBootstrap: '',
      heartbeat: '# Test Checks\n- check stuff',
    },
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('tool-catalog ↔ system prompt sync', () => {
  test('every scheduler_* tool in catalog is documented in HeartbeatModule', () => {
    const schedulerTools = TOOL_CATALOG.filter(t => t.name.startsWith('scheduler_'));
    expect(schedulerTools.length).toBeGreaterThan(0);

    const mod = new HeartbeatModule();
    const ctx = makePromptContext();
    const rendered = mod.render(ctx).join('\n');

    for (const tool of schedulerTools) {
      expect(rendered, `scheduler tool "${tool.name}" missing from HeartbeatModule system prompt`).toContain(tool.name);
    }
  });

  test('every identity/user tool in catalog is documented in IdentityModule', () => {
    const identityTools = TOOL_CATALOG.filter(t =>
      t.name === 'identity_write' || t.name === 'user_write'
    );
    expect(identityTools.length).toBeGreaterThan(0);

    const mod = new IdentityModule();
    const ctx = makePromptContext();
    const rendered = mod.render(ctx).join('\n');

    for (const tool of identityTools) {
      expect(rendered, `identity tool "${tool.name}" missing from IdentityModule system prompt`).toContain(tool.name);
    }
  });
});

// ── tool-catalog ↔ IPC schemas sync ──────────────────────────────────

describe('tool-catalog ↔ IPC schemas sync', () => {
  test('every tool in catalog has a corresponding IPC schema', () => {
    for (const tool of TOOL_CATALOG) {
      expect(IPC_SCHEMAS, `IPC schema missing for tool "${tool.name}"`).toHaveProperty(tool.name);
    }
  });

  test('every IPC_SCHEMAS action has a corresponding tool in TOOL_CATALOG or is an internal-only action', () => {
    // Some IPC actions exist only in IPC_SCHEMAS without a tool catalog entry
    // because they're host-internal (e.g. browser_*, skill_*, agent_delegate, llm_call).
    // The catalog contains agent-facing tools; IPC schemas cover all actions.
    // This test verifies that every CATALOG tool has a schema (no gaps in the other direction).
    const schemaActions = new Set(Object.keys(IPC_SCHEMAS));
    const catalogNames = new Set(TOOL_NAMES);

    // Every catalog tool MUST have a schema
    for (const name of catalogNames) {
      expect(schemaActions.has(name), `Tool "${name}" in catalog but missing from IPC_SCHEMAS`).toBe(true);
    }

    // Every schema action should either be in the catalog OR be a known internal action
    // (browser_*, skill_*, agent_delegate, llm_call are not agent-exposed tools)
    const knownInternalActions = new Set([
      'llm_call',
      'browser_launch', 'browser_navigate', 'browser_snapshot',
      'browser_click', 'browser_type', 'browser_screenshot', 'browser_close',
      'skill_read', 'skill_list', 'skill_propose',
      'agent_delegate',
    ]);

    for (const action of schemaActions) {
      const inCatalog = catalogNames.has(action);
      const isInternal = knownInternalActions.has(action);
      expect(
        inCatalog || isInternal,
        `IPC action "${action}" is neither in TOOL_CATALOG nor in knownInternalActions — update the test or add it to the catalog`,
      ).toBe(true);
    }
  });
});
