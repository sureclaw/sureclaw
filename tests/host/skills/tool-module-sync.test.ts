import { describe, it, expect } from 'vitest';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';
import type { SkillCredStore } from '../../../src/host/skills/skill-cred-store.js';
import type {
  WorkspaceProvider,
  CommitFilesInput,
  CommitFilesResult,
} from '../../../src/providers/workspace/types.js';
import {
  syncToolModulesForSkill,
  type ToolModuleSyncDeps,
  type ToolModuleSyncInput,
} from '../../../src/host/skills/tool-module-sync.js';

// --- Fixtures ------------------------------------------------------------

type DiscoverOpts = Parameters<
  import('../../../src/plugins/mcp-manager.js').McpConnectionManager['discoverAllTools']
>[1];

interface AddServerCall {
  agentId: string;
  server: { name: string; type: string; url: string };
  opts: { source?: string } | undefined;
}

function makeMcpManager(tools: McpToolSchema[]): {
  mcpManager: {
    discoverAllTools: (agentId: string, opts?: DiscoverOpts) => Promise<McpToolSchema[]>;
    addServer: (
      agentId: string,
      server: { name: string; type: string; url: string },
      opts?: { source?: string },
    ) => void;
  };
  calls: Array<{ agentId: string; opts?: DiscoverOpts }>;
  addServerCalls: AddServerCall[];
} {
  const calls: Array<{ agentId: string; opts?: DiscoverOpts }> = [];
  const addServerCalls: AddServerCall[] = [];
  return {
    mcpManager: {
      async discoverAllTools(agentId, opts) {
        calls.push({ agentId, opts });
        return tools;
      },
      addServer(agentId, server, opts) {
        addServerCalls.push({ agentId, server, opts });
      },
    },
    calls,
    addServerCalls,
  };
}

function makeCredStore(rows: Array<{
  skillName: string;
  envName: string;
  userId: string;
  value: string;
}>): SkillCredStore {
  return {
    async put() {},
    async get() { return null; },
    async listForAgent() { return rows; },
    async listEnvNames() { return new Set(rows.map(r => r.envName)); },
    async deleteForSkill() {},
  };
}

function makeWorkspace(result: CommitFilesResult): {
  workspace: WorkspaceProvider;
  commitCalls: Array<{ agentId: string; input: CommitFilesInput }>;
} {
  const commitCalls: Array<{ agentId: string; input: CommitFilesInput }> = [];
  return {
    workspace: {
      async getRepoUrl() { return { url: 'irrelevant', created: false }; },
      async ensureLocalMirror() { return '/tmp/irrelevant-mirror'; },
      async commitFiles(agentId, input) {
        commitCalls.push({ agentId, input });
        return result;
      },
      async close() {},
    },
    commitCalls,
  };
}

// A minimal two-tool / one-server tool schema fixture.
const linearTools: McpToolSchema[] = [
  {
    name: 'list_issues',
    description: 'List issues',
    inputSchema: { type: 'object', properties: { teamId: { type: 'string' } } },
    server: 'linear',
  },
  {
    name: 'get_issue',
    description: 'Get one issue by id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    server: 'linear',
  },
];

const mcpServers = [
  { name: 'linear', url: 'https://mcp.linear.app' },
];

// --- Tests ---------------------------------------------------------------

describe('syncToolModulesForSkill', () => {
  it('registers every input.mcpServer via addServer with source:skill before discoverAllTools', async () => {
    // Regression: the host-global mcpManager Map drives `discoverAllTools`.
    // A fresh skill-approval passes its declared servers via
    // `input.mcpServers`, but the helper used to only filter on those names
    // — the names weren't in the Map, so discovery returned zero tools and
    // no `.ax/tools/<skill>/` commit ever landed. Assert the addServer call
    // happens, and happens BEFORE discoverAllTools so the filter matches.
    const { mcpManager, calls, addServerCalls } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([]);
    const { workspace } = makeWorkspace({ commit: 'abc', changed: true });

    const multiServer = [
      { name: 'linear', url: 'https://mcp.linear.app/sse' },
      { name: 'linear-admin', url: 'https://admin.linear.app/mcp' },
    ];

    // Track invocation order: addServer calls land on addServerCalls BEFORE
    // discoverAllTools pushes onto calls.
    const originalDiscover = mcpManager.discoverAllTools;
    mcpManager.discoverAllTools = async (agentId, opts) => {
      // Sanity: at this point addServer must have been called for every server.
      expect(addServerCalls.map(c => c.server.name).sort()).toEqual(
        multiServer.map(s => s.name).sort(),
      );
      return originalDiscover.call(mcpManager, agentId, opts);
    };

    await syncToolModulesForSkill(
      { mcpManager: mcpManager as any, skillCredStore, workspace },
      { agentId: 'agent-1', skillName: 'linear', mcpServers: multiServer, userId: 'alice' },
    );

    expect(addServerCalls).toHaveLength(2);
    for (const call of addServerCalls) {
      expect(call.agentId).toBe('agent-1');
      expect(call.server.type).toBe('http');
      expect(call.opts).toEqual({ source: 'skill' });
    }
    expect(calls).toHaveLength(1); // discoverAllTools was called once
  });

  it('commits <server>.js, index.js barrel, and _index.json under .ax/tools/<skill>/', async () => {
    const { mcpManager } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: 'alice', value: 'sekret' },
    ]);
    const { workspace, commitCalls } = makeWorkspace({ commit: 'abc123', changed: true });

    const deps: ToolModuleSyncDeps = {
      mcpManager: mcpManager as any,
      skillCredStore,
      workspace,
    };
    const input: ToolModuleSyncInput = {
      agentId: 'agent-1',
      skillName: 'linear',
      mcpServers,
      userId: 'alice',
    };

    const result = await syncToolModulesForSkill(deps, input);

    expect(commitCalls).toHaveLength(1);
    const paths = commitCalls[0].input.files.map(f => f.path).sort();
    expect(paths).toEqual([
      '.ax/tools/linear/_index.json',
      '.ax/tools/linear/index.js',
      '.ax/tools/linear/linear.js',
    ]);
    expect(result.commit).toBe('abc123');
    expect(result.changed).toBe(true);
    expect(result.toolCount).toBe(2);
    // moduleCount excludes _index.json; barrel + server module included.
    expect(result.moduleCount).toBe(2);
  });

  it('_index.json has { skill, tools[], generated_at } with correct tool metadata', async () => {
    const { mcpManager } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([]);
    const { workspace, commitCalls } = makeWorkspace({ commit: 'def', changed: true });

    await syncToolModulesForSkill(
      { mcpManager: mcpManager as any, skillCredStore, workspace },
      { agentId: 'agent-1', skillName: 'linear', mcpServers, userId: 'alice' },
    );

    const indexFile = commitCalls[0].input.files.find(f => f.path === '.ax/tools/linear/_index.json');
    expect(indexFile).toBeDefined();
    expect(typeof indexFile!.content).toBe('string');
    const parsed = JSON.parse(indexFile!.content as string);
    expect(parsed.skill).toBe('linear');
    expect(parsed.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.tools).toEqual([
      {
        name: 'list_issues',
        description: 'List issues',
        parameters: { type: 'object', properties: { teamId: { type: 'string' } } },
      },
      {
        name: 'get_issue',
        description: 'Get one issue by id',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ]);
  });

  it('uses approval-time commit message and AX Host author', async () => {
    const { mcpManager } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([]);
    const { workspace, commitCalls } = makeWorkspace({ commit: 'x', changed: true });

    await syncToolModulesForSkill(
      { mcpManager: mcpManager as any, skillCredStore, workspace },
      { agentId: 'agent-1', skillName: 'linear', mcpServers, userId: 'alice' },
    );

    expect(commitCalls[0].input.message).toBe('ax: regenerate tools for linear');
    expect(commitCalls[0].input.author).toEqual({ name: 'AX Host', email: 'host@ax' });
  });

  it('uses refresh-time commit message when reason === "refresh"', async () => {
    const { mcpManager } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([]);
    const { workspace, commitCalls } = makeWorkspace({ commit: 'x', changed: true });

    await syncToolModulesForSkill(
      { mcpManager: mcpManager as any, skillCredStore, workspace },
      { agentId: 'agent-1', skillName: 'linear', mcpServers, userId: 'alice', reason: 'refresh' },
    );

    expect(commitCalls[0].input.message).toBe('ax: refresh tools for linear');
  });

  it('defaults to approval commit message when reason is omitted or set to approval', async () => {
    const { mcpManager } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([]);
    const { workspace, commitCalls } = makeWorkspace({ commit: 'x', changed: true });

    await syncToolModulesForSkill(
      { mcpManager: mcpManager as any, skillCredStore, workspace },
      { agentId: 'agent-1', skillName: 'linear', mcpServers, userId: 'alice', reason: 'approval' },
    );

    expect(commitCalls[0].input.message).toBe('ax: regenerate tools for linear');
  });

  it('passes a serverFilter containing only the skill-declared server names', async () => {
    const { mcpManager, calls } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([]);
    const { workspace } = makeWorkspace({ commit: 'x', changed: true });

    await syncToolModulesForSkill(
      { mcpManager: mcpManager as any, skillCredStore, workspace },
      {
        agentId: 'agent-1',
        skillName: 'linear',
        mcpServers: [
          { name: 'linear', url: 'https://mcp.linear.app' },
          { name: 'notion', url: 'https://mcp.notion.com' },
        ],
        userId: 'alice',
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe('agent-1');
    const filter = calls[0].opts?.serverFilter;
    expect(filter).toBeInstanceOf(Set);
    expect([...filter!].sort()).toEqual(['linear', 'notion']);
  });

  it('authForServer closure resolves credentials from skillCredStore for the skill-declared servers', async () => {
    const { mcpManager, calls } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: 'alice', value: 'sekret-alice' },
    ]);
    const { workspace } = makeWorkspace({ commit: 'x', changed: true });

    await syncToolModulesForSkill(
      { mcpManager: mcpManager as any, skillCredStore, workspace },
      { agentId: 'agent-1', skillName: 'linear', mcpServers, userId: 'alice' },
    );

    const authForServer = calls[0].opts?.authForServer;
    expect(authForServer).toBeDefined();
    const headers = await authForServer!({ name: 'linear', url: 'https://mcp.linear.app' });
    expect(headers).toEqual({ Authorization: 'Bearer sekret-alice' });
  });

  it('returns { commit: null, changed: false, counts: 0 } and does NOT call commitFiles when no tools discovered', async () => {
    const { mcpManager } = makeMcpManager([]);
    const skillCredStore = makeCredStore([]);
    const { workspace, commitCalls } = makeWorkspace({ commit: 'never', changed: true });

    const result = await syncToolModulesForSkill(
      { mcpManager: mcpManager as any, skillCredStore, workspace },
      { agentId: 'agent-1', skillName: 'linear', mcpServers, userId: 'alice' },
    );

    expect(commitCalls).toHaveLength(0);
    expect(result).toEqual({
      commit: null,
      changed: false,
      moduleCount: 0,
      toolCount: 0,
    });
  });

  it('rejects skillName values that would escape the tools directory or corrupt the commit message', async () => {
    const { mcpManager } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([]);
    const { workspace, commitCalls } = makeWorkspace({ commit: 'x', changed: true });

    const bogus = [
      '../evil',       // path traversal
      'foo/bar',       // slash
      '',              // empty
      'linear\nfoo',   // newline (would corrupt commit message)
      ' linear',       // leading space
      'linear ',       // trailing space
      '-linear',       // leading dash
    ];

    for (const skillName of bogus) {
      await expect(
        syncToolModulesForSkill(
          { mcpManager: mcpManager as any, skillCredStore, workspace },
          { agentId: 'agent-1', skillName, mcpServers, userId: 'alice' },
        ),
      ).rejects.toThrow();
    }
    expect(commitCalls).toHaveLength(0);
  });

  it('propagates errors thrown by workspace.commitFiles', async () => {
    const { mcpManager } = makeMcpManager(linearTools);
    const skillCredStore = makeCredStore([]);
    const workspace: WorkspaceProvider = {
      async getRepoUrl() { return { url: '', created: false }; },
      async commitFiles() { throw new Error('boom'); },
      async close() {},
    };

    await expect(
      syncToolModulesForSkill(
        { mcpManager: mcpManager as any, skillCredStore, workspace },
        { agentId: 'agent-1', skillName: 'linear', mcpServers, userId: 'alice' },
      ),
    ).rejects.toThrow('boom');
  });
});
