/**
 * Sync tests: verify the tool catalog stays in sync with consumers.
 *
 * - tool-catalog <-> mcp-server: tool names and parameter keys match
 * - tool-catalog <-> system prompt: every tool is documented in the
 *   appropriate prompt module so the LLM knows to use it
 * - tool-catalog <-> IPC schemas: every tool's actions have Zod schemas
 */

import { describe, test, expect, vi } from 'vitest';
import { TOOL_CATALOG, TOOL_NAMES, getToolParamKeys } from '../../src/agent/tool-catalog.js';
import { createIPCMcpServer } from '../../src/agent/mcp-server.js';
import { HeartbeatModule } from '../../src/agent/prompt/modules/heartbeat.js';
import { IdentityModule } from '../../src/agent/prompt/modules/identity.js';
import { SkillsModule } from '../../src/agent/prompt/modules/skills.js';
import { DelegationModule } from '../../src/agent/prompt/modules/delegation.js';
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

describe('tool-catalog <-> mcp-server sync', () => {
  test('MCP tool names exactly match TOOL_NAMES', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const mcpToolNames = Object.keys(getTools(server)).sort();
    const catalogNames = [...TOOL_NAMES].sort();
    expect(mcpToolNames).toEqual(catalogNames);
  });

  test('each MCP tool parameter keys are a superset of catalog getToolParamKeys', () => {
    const client = createMockClient();
    const server = createIPCMcpServer(client);
    const tools = getTools(server);

    for (const name of TOOL_NAMES) {
      const mcpTool = tools[name];
      expect(mcpTool, `MCP tool "${name}" not found`).toBeDefined();

      // Extract Zod schema keys from the MCP tool's inputSchema
      // Zod v4 stores shape at inputSchema.def.shape
      const zodShape = mcpTool.inputSchema?.def?.shape ?? {};
      const mcpKeys = new Set(Object.keys(zodShape));
      const catalogKeys = getToolParamKeys(name);

      // For union-based tools, MCP uses flat optional fields (superset)
      // while catalog uses discriminated unions. MCP keys should include
      // all catalog keys plus the 'type' discriminator.
      for (const key of catalogKeys) {
        expect(mcpKeys.has(key), `MCP tool "${name}" missing param key "${key}" from catalog`).toBe(true);
      }
    }
  });
});

// ── tool-catalog <-> system prompt sync ────────────────────────────────
//
// Tools registered in the API's tools[] are only half the story.
// The system prompt must ALSO document each tool so the LLM knows
// when and how to use it. Without prompt guidance, models hallucinate
// the behavior instead of calling the tool.

function makePromptContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
    workspace: '/tmp',
    skills: [],
    profile: 'balanced',
    sandboxType: 'docker',
    taintRatio: 0,
    taintThreshold: 0.10,
    identityFiles: {
      agents: '', soul: 'I am a test agent', identity: 'Test identity.',
      bootstrap: '', userBootstrap: '',
      heartbeat: '# Test Checks\n- check stuff',
    },
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('tool-catalog <-> system prompt sync', () => {
  test('scheduler tool type values are documented in HeartbeatModule', () => {
    const schedulerTool = TOOL_CATALOG.find(t => t.name === 'scheduler');
    expect(schedulerTool).toBeDefined();

    const mod = new HeartbeatModule();
    const ctx = makePromptContext();
    const rendered = mod.render(ctx).join('\n');

    // The prompt should reference the consolidated 'scheduler' tool name
    expect(rendered, 'scheduler tool name missing from HeartbeatModule').toContain('scheduler');

    // And document the type values: add_cron, run_at, remove, list
    for (const typeValue of Object.keys(schedulerTool!.actionMap!)) {
      expect(rendered, `scheduler type "${typeValue}" missing from HeartbeatModule`).toContain(typeValue);
    }
  });

  test('skill creation instructions are documented in SkillsModule', () => {
    const mod = new SkillsModule();
    const ctx = makePromptContext({ skills: [{ name: 'Dummy', description: 'dummy', path: 'dummy.md' }] });
    const rendered = mod.render(ctx).join('\n');
    // Should reference filesystem-based skill paths and read_file tool
    expect(rendered, 'skill path missing from SkillsModule system prompt').toContain('/workspace/skills/');
    expect(rendered, 'read_file tool missing from SkillsModule system prompt').toContain('read_file');
  });

  test('delegate tool is documented in DelegationModule', () => {
    const mod = new DelegationModule();
    const ctx = makePromptContext();
    const rendered = mod.render(ctx).join('\n');
    expect(rendered, 'delegate missing from DelegationModule system prompt').toContain('delegate');
    // Should recommend claude-code for coding tasks
    expect(rendered, 'DelegationModule should recommend claude-code for coding').toContain('claude-code');
    // Should tell the LLM to keep context minimal
    expect(rendered, 'DelegationModule should warn against dumping full identity').toContain('Do NOT paste');
  });

  test('identity evolution is documented in IdentityModule', () => {
    const mod = new IdentityModule();
    const ctx = makePromptContext();
    const rendered = mod.render(ctx).join('\n');

    // Should reference git-based identity files
    expect(rendered, '.ax/SOUL.md path missing from IdentityModule').toContain('.ax/SOUL.md');
    // Should document git commit workflow
    expect(rendered, 'git commit missing from IdentityModule').toContain('git');
    expect(rendered, 'Identity Evolution heading missing').toContain('Identity Evolution');
  });
});

// ── tool-catalog <-> IPC schemas sync ──────────────────────────────────

describe('tool-catalog <-> IPC schemas sync', () => {
  test('every tool action in catalog has a corresponding IPC schema', () => {
    for (const tool of TOOL_CATALOG) {
      if (tool.actionMap) {
        // Multi-op tool: every action in the actionMap must have an IPC schema
        for (const [typeValue, ipcAction] of Object.entries(tool.actionMap)) {
          expect(IPC_SCHEMAS, `IPC schema missing for action "${ipcAction}" (tool "${tool.name}", type "${typeValue}")`).toHaveProperty(ipcAction);
        }
      } else if (tool.singletonAction) {
        // Singleton tool: the singletonAction must have an IPC schema
        expect(IPC_SCHEMAS, `IPC schema missing for singleton action "${tool.singletonAction}" (tool "${tool.name}")`).toHaveProperty(tool.singletonAction);
      }
    }
  });

  test('every IPC_SCHEMAS action is either mapped from a catalog tool or is a known internal action', () => {
    // Build set of all IPC actions referenced by the catalog
    const catalogActions = new Set<string>();
    for (const tool of TOOL_CATALOG) {
      if (tool.actionMap) {
        for (const action of Object.values(tool.actionMap)) {
          catalogActions.add(action);
        }
      } else if (tool.singletonAction) {
        catalogActions.add(tool.singletonAction);
      }
    }

    const schemaActions = new Set(Object.keys(IPC_SCHEMAS));

    // Every catalog action MUST have a schema
    for (const action of catalogActions) {
      expect(schemaActions.has(action), `Catalog action "${action}" missing from IPC_SCHEMAS`).toBe(true);
    }

    // Every schema action should either be in the catalog OR be a known internal action
    // (browser_*, llm_call are not agent-exposed tools)
    const knownInternalActions = new Set([
      'llm_call',
      'browser_launch', 'browser_navigate', 'browser_snapshot',
      'browser_click', 'browser_type', 'browser_screenshot', 'browser_close',
      // workspace_write kept as backward-compat alias (save_artifact is the catalog name)
      'workspace_write',
      // Plugin management (host-internal, not agent-facing)
      'plugin_list', 'plugin_status',
      // Orchestration (host-internal, agents interact via IPC handlers)
      'agent_orch_status', 'agent_orch_list', 'agent_orch_tree',
      'agent_orch_message', 'agent_orch_poll', 'agent_orch_interrupt',
      // Sandbox audit gate (container-local execution, agent → host pre/post hooks)
      'sandbox_approve', 'sandbox_result',
      // Agent response (NATS mode — agent sends response via IPC instead of stdout)
      'agent_response',
      // Workspace release (NATS mode — agent sends workspace file changes via IPC)
      'workspace_release',
      // Session lifecycle (host → pod push notification)
      'session_expiring',
      // Tool batch (scripted tool execution with __batchRef pipelining, not agent-facing tool)
      'tool_batch',
      // Agent work loop (multi-turn sessions — agent polls for queued work)
      'fetch_work',
      // Commit validation (git sidecar → host, validates .ax/ diffs before committing)
      'validate_commit',
    ]);

    for (const action of schemaActions) {
      const inCatalog = catalogActions.has(action);
      const isInternal = knownInternalActions.has(action);
      expect(
        inCatalog || isInternal,
        `IPC action "${action}" is neither mapped from TOOL_CATALOG nor in knownInternalActions — update the test or add it to the catalog`,
      ).toBe(true);
    }
  });
});
