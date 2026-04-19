/**
 * Tool-module sync: discovers a skill's MCP tools and commits wrapped
 * ES modules into the agent's workspace repo under `.ax/tools/<skill>/`.
 *
 * Called from the skill-approval path and the admin refresh-tools
 * endpoint. One commit per call. Errors propagate — the caller
 * decides whether to fail-loud (refresh) or log-and-continue (approval).
 *
 * Module layout per skill:
 *   .ax/tools/<skill>/<server>.js    — one per declared MCP server that yields tools
 *   .ax/tools/<skill>/index.js       — barrel re-export of all <server>.js modules
 *   .ax/tools/<skill>/_index.json    — { skill, tools[], generated_at } for the
 *                                      agent-side prompt builder + drift checks
 *
 * `moduleCount` in the result counts every `.js` file (server modules + barrel).
 * The `_index.json` is subtracted out; it is metadata, not an executable module.
 */

import type { McpConnectionManager } from '../../plugins/mcp-manager.js';
import type { WorkspaceProvider, CommitFilesInput } from '../../providers/workspace/types.js';
import type { SkillCredStore } from './skill-cred-store.js';
import { resolveMcpAuthHeaders } from '../server-completions.js';
import { prepareToolModules } from '../toolgen/generate-and-cache.js';

const HOST_AUTHOR = { name: 'AX Host', email: 'host@ax' } as const;

export interface ToolModuleSyncDeps {
  mcpManager: McpConnectionManager;
  skillCredStore: SkillCredStore;
  workspace: WorkspaceProvider;
}

export interface ToolModuleSyncInput {
  agentId: string;
  skillName: string;
  mcpServers: Array<{
    name: string;
    url: string;
    credential?: string;
    transport?: 'http' | 'sse';
  }>;
  /** For per-user credential resolution via `resolveMcpAuthHeaders`. */
  userId: string;
  /** Selects the git commit message. `approval` → "ax: regenerate tools for
   *  <skill>" (default, preserves existing behavior); `refresh` → "ax: refresh
   *  tools for <skill>" (admin refresh-tools endpoint). */
  reason?: 'approval' | 'refresh';
}

export interface ToolModuleSyncResult {
  /** SHA of `refs/heads/main` after the commit, or `null` when no commit was
   *  made (discovery returned zero tools). */
  commit: string | null;
  changed: boolean;
  /** Count of `.js` module files written (server modules + barrel). */
  moduleCount: number;
  /** Count of discovered MCP tools across the skill's declared servers. */
  toolCount: number;
}

export async function syncToolModulesForSkill(
  deps: ToolModuleSyncDeps,
  input: ToolModuleSyncInput,
): Promise<ToolModuleSyncResult> {
  assertSkillNameSafe(input.skillName);

  // Register the skill's declared MCP servers with mcpManager BEFORE
  // discovery. Without this, `discoverAllTools` iterates an empty registry
  // for a fresh approval and returns zero tools — no commit, no
  // `.ax/tools/<skill>/` tree ever lands in the agent's repo. The lazy
  // hook in `loadSnapshot` handles restart/session-start; this call
  // handles the approval-time ordering where discovery must run before
  // the next snapshot invalidation cycle.
  for (const s of input.mcpServers) {
    deps.mcpManager.addServer(
      input.agentId,
      { name: s.name, type: 'http', url: s.url, transport: s.transport },
      { source: 'skill' },
    );
  }

  const serverFilter = new Set(input.mcpServers.map(s => s.name));

  const authForServer = async (server: { name: string; url: string }) =>
    resolveMcpAuthHeaders({
      serverName: server.name,
      agentId: input.agentId,
      userId: input.userId,
      skillCredStore: deps.skillCredStore,
    });

  const tools = await deps.mcpManager.discoverAllTools(input.agentId, {
    authForServer,
    serverFilter,
  });

  if (tools.length === 0) {
    return { commit: null, changed: false, moduleCount: 0, toolCount: 0 };
  }

  const modules = await prepareToolModules({ agentName: input.agentId, tools });
  if (!modules) {
    throw new Error(`prepareToolModules returned null despite ${tools.length} tools`);
  }

  const baseDir = `.ax/tools/${input.skillName}`;
  const files: CommitFilesInput['files'] = modules.files.map(f => ({
    path: `${baseDir}/${f.path}`,
    content: f.content,
  }));

  const indexJson = {
    skill: input.skillName,
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
    generated_at: new Date().toISOString(),
  };
  files.push({
    path: `${baseDir}/_index.json`,
    content: JSON.stringify(indexJson, null, 2),
  });

  const verb = input.reason === 'refresh' ? 'refresh' : 'regenerate';
  const result = await deps.workspace.commitFiles(input.agentId, {
    files,
    message: `ax: ${verb} tools for ${input.skillName}`,
    author: { ...HOST_AUTHOR },
  });

  return {
    commit: result.commit,
    changed: result.changed,
    moduleCount: modules.files.length,
    toolCount: tools.length,
  };
}

/** `skillName` shows up verbatim in a repo-relative path and in a git commit
 *  message. safePath protects the filesystem layer, but the commit lands on
 *  `refs/heads/main` by path string — a `..` or `/` segment would silently
 *  land the commit somewhere unintended, and a `\r`/`\n` would corrupt the
 *  commit message. Positive-match allowlist: must start with alnum, then
 *  alnum/dot/dash/underscore only. The `..` belt-and-braces check rejects
 *  `foo..bar`, which otherwise matches the regex. */
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function assertSkillNameSafe(skillName: string): void {
  if (!SKILL_NAME_RE.test(skillName) || skillName.includes('..')) {
    throw new Error(`invalid skillName: ${JSON.stringify(skillName)}`);
  }
}
