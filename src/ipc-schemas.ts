import { z } from 'zod';

// ═══════════════════════════════════════════════════════
// Shared validators
// ═══════════════════════════════════════════════════════

/** Safe string: no null bytes, reasonable length */
const safeString = (maxLen: number = 10_000) =>
  z.string().max(maxLen).check(
    z.refine(s => !s.includes('\0'), 'Null bytes not allowed')
  );

/** Scope names: alphanumeric start, safe chars */
const scopeName = z.string()
  .min(1)
  .max(200)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_\-/]{0,199}$/,
    'Scope must start with alphanumeric, contain only alphanumeric/underscore/hyphen/slash'
  );

/** UUID format */
const uuid = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'Must be a valid UUID'
);

// ═══════════════════════════════════════════════════════
// Builder + auto-registry
// ═══════════════════════════════════════════════════════

const registry: [string, z.ZodType][] = [];

/** Create a strict IPC action schema and register it in IPC_SCHEMAS. */
function ipcAction<T extends z.ZodRawShape>(action: string, fields: T) {
  const schema = z.strictObject({ action: z.literal(action), ...fields });
  registry.push([action, schema]);
  return schema;
}

// ═══════════════════════════════════════════════════════
// Action schemas
// ═══════════════════════════════════════════════════════

// ── LLM ──────────────────────────────────────────────

const contentBlock = z.union([
  z.strictObject({ type: z.literal('text'), text: safeString(200_000) }),
  z.strictObject({ type: z.literal('tool_use'), id: safeString(200), name: safeString(200), input: z.any() }),
  z.strictObject({ type: z.literal('tool_result'), tool_use_id: safeString(200), content: safeString(250_000) }),
  z.strictObject({ type: z.literal('image'), fileId: safeString(1024), mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']) }),
  z.strictObject({ type: z.literal('image_data'), data: safeString(20_000_000), mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']) }),
  z.strictObject({ type: z.literal('file'), fileId: safeString(1024), mimeType: safeString(128), filename: safeString(512) }),
  z.strictObject({ type: z.literal('file_data'), data: safeString(20_000_000), mimeType: safeString(128), filename: safeString(512) }),
]);

export const LlmCallSchema = ipcAction('llm_call', {
  model: safeString(128).optional(),
  taskType: z.enum(['default', 'fast', 'thinking', 'coding']).optional(),
  messages: z.array(z.strictObject({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.union([safeString(200_000), z.array(contentBlock)]),
  })).min(1).max(200),
  tools: z.array(z.strictObject({
    name: safeString(100),
    description: safeString(10000),
    parameters: z.any(),
  })).max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
});

// ── Memory ───────────────────────────────────────────

export const MemoryWriteSchema = ipcAction('memory_write', {
  scope: scopeName,
  content: safeString(100_000),
  tags: z.array(safeString(100)).optional(),
  tainted: z.boolean().optional(),
  pool: z.enum(['agent', 'company']).optional(),
});

export const MemoryQuerySchema = ipcAction('memory_query', {
  scope: scopeName,
  query: safeString(10_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  tags: z.array(safeString(100)).optional(),
  pool: z.enum(['agent', 'company', 'both']).optional(),
});

export const MemoryReadSchema = ipcAction('memory_read', { id: uuid });

export const MemoryDeleteSchema = ipcAction('memory_delete', { id: uuid });

export const MemoryListSchema = ipcAction('memory_list', {
  scope: scopeName,
  limit: z.number().int().min(1).max(100).optional(),
});

// ── Web ──────────────────────────────────────────────

export const WebFetchSchema = ipcAction('web_fetch', {
  url: z.url().max(2048),
  method: z.enum(['GET', 'HEAD']).optional(),
  headers: z.record(safeString(200), safeString(4096)).optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
});

export const WebSearchSchema = ipcAction('web_search', {
  query: safeString(1000),
  maxResults: z.number().int().min(1).max(20).optional(),
});

export const WebExtractSchema = ipcAction('web_extract', {
  url: z.url().max(2048),
});

// ── Skills ───────────────────────────────────────────

export const SkillInstallSchema = ipcAction('skill_install', {
  query: safeString(500).optional(),
  slug: safeString(200).optional(),
});

export const SkillUpdateSchema = ipcAction('skill_update', {
  slug: safeString(200),
  path: safeString(1024),
  content: safeString(500_000),
});

export const SkillCreateSchema = ipcAction('skill_create', {
  slug: safeString(200),
  content: safeString(500_000),
});

export const SkillDeleteSchema = ipcAction('skill_delete', {
  slug: safeString(200),
});

/**
 * Agent asks the host for its authoritative skill index.
 * Handler uses ctx.agentId from the IPC session — no request fields needed.
 *
 * Response shape (not schema-validated, but producer-guaranteed):
 * {
 *   skills: Array<{
 *     name: string;
 *     description?: string;
 *     kind: 'enabled' | 'pending' | 'invalid';
 *     pendingReasons?: string[];
 *   }>
 * }
 */
export const SkillsIndexSchema = ipcAction('skills_index', {});

export const CredentialRequestSchema = ipcAction('credential_request', {
  envName: safeString(200),
});

// ── Audit ────────────────────────────────────────────

export const AuditQuerySchema = ipcAction('audit_query', {
  filter: z.strictObject({
    action: safeString(100).optional(),
    sessionId: safeString(128).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).optional(),
});

// ── Agent Delegation ────────────────────────────────

export const AgentDelegateSchema = ipcAction('agent_delegate', {
  task: safeString(50_000),
  context: safeString(100_000).optional(),
  runner: z.enum(['pi-coding-agent', 'claude-code']).optional(),
  model: safeString(128).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  timeoutSec: z.number().int().min(5).max(600).optional(),
  wait: z.boolean().optional(),
  resourceTier: z.enum(['default', 'heavy']).optional(),
});

export const AgentCollectSchema = ipcAction('agent_collect', {
  handleIds: z.array(safeString(128)).min(1).max(20),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

// ── Scheduler ──────────────────────────────────────────

export const SchedulerAddCronSchema = ipcAction('scheduler_add_cron', {
  schedule: safeString(100),
  prompt: safeString(10_000),
  maxTokenBudget: z.number().int().min(1).optional(),
  delivery: z.strictObject({
    mode: z.enum(['channel', 'none']),
    target: z.union([
      z.literal('last'),
      z.strictObject({
        provider: safeString(50),
        scope: z.enum(['dm', 'channel', 'thread', 'group']),
        identifiers: z.strictObject({
          workspace: safeString(200).optional(),
          channel: safeString(200).optional(),
          thread: safeString(200).optional(),
          peer: safeString(200).optional(),
        }),
      }),
    ]).optional(),
  }).optional(),
});

export const SchedulerRunAtSchema = ipcAction('scheduler_run_at', {
  datetime: safeString(100),
  prompt: safeString(10_000),
  maxTokenBudget: z.number().int().min(1).optional(),
  delivery: z.strictObject({
    mode: z.enum(['channel', 'none']),
    target: z.union([
      z.literal('last'),
      z.strictObject({
        provider: safeString(50),
        scope: z.enum(['dm', 'channel', 'thread', 'group']),
        identifiers: z.strictObject({
          workspace: safeString(200).optional(),
          channel: safeString(200).optional(),
          thread: safeString(200).optional(),
          peer: safeString(200).optional(),
        }),
      }),
    ]).optional(),
  }).optional(),
});

export const SchedulerRemoveCronSchema = ipcAction('scheduler_remove_cron', {
  id: safeString(200),
});

export const SchedulerListJobsSchema = ipcAction('scheduler_list_jobs', {});

// ── Artifact ──────────────────────────────────────────

export const SaveArtifactSchema = ipcAction('save_artifact', {
  tier: z.enum(['agent', 'user', 'session']),
  path: safeString(1024),
  content: safeString(500_000),
});

// ── Session Lifecycle ──────────────────────────────────

export const SessionExpiringSchema = ipcAction('session_expiring', {
  secondsRemaining: z.number().int().min(0).max(600),
  reason: z.enum(['idle_timeout', 'shutdown']),
});

// ── Agent Orchestration ────────────────────────────────

const agentHandleId = safeString(128);

/** All valid agent lifecycle states — shared across schemas to avoid duplication. */
const agentStates = ['spawning', 'running', 'thinking', 'tool_calling', 'waiting_for_llm', 'delegating', 'interrupted', 'completed', 'failed', 'canceled'] as const;
const agentStateEnum = z.enum(agentStates);

export const AgentOrchStatusSchema = ipcAction('agent_orch_status', {
  handleId: agentHandleId.optional(),
});

export const AgentOrchListSchema = ipcAction('agent_orch_list', {
  sessionId: safeString(128).optional(),
  userId: safeString(200).optional(),
  parentId: agentHandleId.optional(),
  state: z.union([agentStateEnum, z.array(agentStateEnum)]).optional(),
});

export const AgentOrchTreeSchema = ipcAction('agent_orch_tree', {
  rootId: agentHandleId,
});

export const AgentOrchMessageSchema = ipcAction('agent_orch_message', {
  to: agentHandleId,
  type: z.enum(['request', 'response', 'notification']),
  payload: z.record(safeString(200), z.unknown()).refine(
    obj => JSON.stringify(obj).length <= 50_000,
    'Payload too large (max 50KB)'
  ),
  correlationId: safeString(128).optional(),
  policyTags: z.array(safeString(50)).max(10).optional(),
});

export const AgentOrchPollSchema = ipcAction('agent_orch_poll', {
  limit: z.number().int().min(1).max(100).optional(),
});

export const AgentOrchInterruptSchema = ipcAction('agent_orch_interrupt', {
  handleId: agentHandleId,
  reason: safeString(1000),
});

// ── Agent Response (HTTP IPC mode) ──────────────────

export const AgentResponseSchema = ipcAction('agent_response', {
  content: safeString(2_000_000),
});

export const WorkspaceReleaseSchema = ipcAction('workspace_release', {
  staging_key: safeString(128),
});

// ── Sandbox Tools ────────────────────────────────────

export const SandboxBashSchema = ipcAction('sandbox_bash', {
  command: safeString(100_000),
});

export const SandboxReadFileSchema = ipcAction('sandbox_read_file', {
  path: safeString(1024),
});

export const SandboxWriteFileSchema = ipcAction('sandbox_write_file', {
  path: safeString(1024),
  content: safeString(500_000),
});

export const SandboxEditFileSchema = ipcAction('sandbox_edit_file', {
  path: safeString(1024),
  old_string: safeString(500_000),
  new_string: safeString(500_000),
});

export const SandboxGrepSchema = ipcAction('sandbox_grep', {
  pattern: safeString(10_000),
  path: safeString(1024).optional(),
  glob: safeString(1024).optional(),
  max_results: z.number().int().min(1).max(10_000).optional(),
  include_line_numbers: z.boolean().optional(),
  context_lines: z.number().int().min(0).max(20).optional(),
});

export const SandboxGlobSchema = ipcAction('sandbox_glob', {
  pattern: safeString(1024),
  path: safeString(1024).optional(),
  max_results: z.number().int().min(1).max(10_000).optional(),
});

// ── Sandbox Audit Gate (container-local execution) ─────────

export const SandboxApproveSchema = ipcAction('sandbox_approve', {
  operation: z.enum(['bash', 'read', 'write', 'edit', 'grep', 'glob']),
  command: safeString(100_000).optional(),
  path: safeString(1024).optional(),
  content: safeString(500_000).optional(),
  old_string: safeString(500_000).optional(),
  new_string: safeString(500_000).optional(),
});

export const SandboxResultSchema = ipcAction('sandbox_result', {
  operation: z.enum(['bash', 'read', 'write', 'edit', 'grep', 'glob']),
  command: safeString(100_000).optional(),
  path: safeString(1024).optional(),
  output: safeString(500_000).optional(),
  exitCode: z.number().int().optional(),
  success: z.boolean().optional(),
  error: safeString(10_000).optional(),
});

// ── Tool Batch (scripted tool execution) ────────────

export const ToolBatchSchema = ipcAction('tool_batch', {
  /** Ordered tool calls. Args may contain { __batchRef, path } for dependent pipelining. */
  calls: z.array(z.object({
    tool: safeString(200),
    args: z.record(z.string(), z.unknown()),
  })),
});

// ── Agent Work Loop ─────────────────────────────────

/** Agent polls for queued work (multi-turn sessions). Returns { ok, payload } */
export const FetchWorkSchema = ipcAction('fetch_work', {});

// ── Plugin Management ────────────────────────────────

export const PluginListSchema = ipcAction('plugin_list', {});

export const PluginStatusSchema = ipcAction('plugin_status', {
  packageName: safeString(214),
});

// ── Commit Validation ────────────────────────────────

export const ValidateCommitSchema = ipcAction('validate_commit', {
  diff: safeString(262_144), // 256KB max diff
});

// ═══════════════════════════════════════════════════════
// Auto-generated registry
// ═══════════════════════════════════════════════════════

export const IPC_SCHEMAS: Record<string, z.ZodType> = Object.fromEntries(registry);
export const VALID_ACTIONS = Object.keys(IPC_SCHEMAS);

/**
 * Envelope schema: validates action field is a known action.
 * Checked BEFORE the action-specific schema.
 */
export const IPCEnvelopeSchema = z.object({
  action: z.enum(VALID_ACTIONS as [string, ...string[]]),
}).passthrough();
