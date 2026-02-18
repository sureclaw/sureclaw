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
  z.strictObject({ type: z.literal('tool_result'), tool_use_id: safeString(200), content: safeString(200_000) }),
]);

export const LlmCallSchema = ipcAction('llm_call', {
  model: safeString(128).optional(),
  messages: z.array(z.strictObject({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.union([safeString(200_000), z.array(contentBlock)]),
  })).min(1).max(200),
  tools: z.array(z.strictObject({
    name: safeString(100),
    description: safeString(2000),
    parameters: z.any(),
  })).max(50).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
});

// ── Memory ───────────────────────────────────────────

export const MemoryWriteSchema = ipcAction('memory_write', {
  scope: scopeName,
  content: safeString(100_000),
  tags: z.array(safeString(100)).optional(),
  tainted: z.boolean().optional(),
});

export const MemoryQuerySchema = ipcAction('memory_query', {
  scope: scopeName,
  query: safeString(10_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  tags: z.array(safeString(100)).optional(),
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

// ── Browser ──────────────────────────────────────────

const browserSession = safeString(128);

export const BrowserLaunchSchema = ipcAction('browser_launch', {
  config: z.strictObject({
    headless: z.boolean().optional(),
    viewport: z.strictObject({
      width: z.number().int().min(320).max(3840).optional(),
      height: z.number().int().min(240).max(2160).optional(),
    }).optional(),
  }).optional(),
});

export const BrowserNavigateSchema = ipcAction('browser_navigate', {
  session: browserSession, url: z.url().max(2048),
});

export const BrowserSnapshotSchema = ipcAction('browser_snapshot', { session: browserSession });

export const BrowserClickSchema = ipcAction('browser_click', {
  session: browserSession, ref: z.number().int().min(0),
});

export const BrowserTypeSchema = ipcAction('browser_type', {
  session: browserSession, ref: z.number().int().min(0), text: safeString(10_000),
});

export const BrowserScreenshotSchema = ipcAction('browser_screenshot', { session: browserSession });

export const BrowserCloseSchema = ipcAction('browser_close', { session: browserSession });

// ── Skills ───────────────────────────────────────────

export const SkillReadSchema = ipcAction('skill_read', { name: safeString(200) });

export const SkillListSchema = ipcAction('skill_list', {});

export const SkillProposeSchema = ipcAction('skill_propose', {
  skill: safeString(200),
  content: safeString(100_000),
  reason: safeString(2000).optional(),
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
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  timeoutSec: z.number().int().min(5).max(600).optional(),
});

// ── Identity ────────────────────────────────────────

export const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md'] as const;

export const IDENTITY_ORIGINS = ['user_request', 'agent_initiated'] as const;

export const IdentityWriteSchema = ipcAction('identity_write', {
  file: z.enum(IDENTITY_FILES),
  content: safeString(32_768),
  reason: safeString(512),
  origin: z.enum(IDENTITY_ORIGINS),
});

export const UserWriteSchema = ipcAction('user_write', {
  userId: safeString(200),
  content: safeString(32_768),
  reason: safeString(512),
  origin: z.enum(IDENTITY_ORIGINS),
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
