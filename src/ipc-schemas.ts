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
// Action schemas — one per IPC action
// ═══════════════════════════════════════════════════════

// ── LLM ──────────────────────────────────────────────

export const LlmCallSchema = z.strictObject({
  action: z.literal('llm_call'),
  model: safeString(128).optional(),
  messages: z.array(z.strictObject({
    role: z.enum(['user', 'assistant', 'system']),
    content: safeString(200_000),
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

export const MemoryWriteSchema = z.strictObject({
  action: z.literal('memory_write'),
  scope: scopeName,
  content: safeString(100_000),
  tags: z.array(safeString(100)).optional(),
  tainted: z.boolean().optional(),
});

export const MemoryQuerySchema = z.strictObject({
  action: z.literal('memory_query'),
  scope: scopeName,
  query: safeString(10_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  tags: z.array(safeString(100)).optional(),
});

export const MemoryReadSchema = z.strictObject({
  action: z.literal('memory_read'),
  id: uuid,
});

export const MemoryDeleteSchema = z.strictObject({
  action: z.literal('memory_delete'),
  id: uuid,
});

export const MemoryListSchema = z.strictObject({
  action: z.literal('memory_list'),
  scope: scopeName,
  limit: z.number().int().min(1).max(100).optional(),
});

// ── Web ──────────────────────────────────────────────

export const WebFetchSchema = z.strictObject({
  action: z.literal('web_fetch'),
  url: z.url().max(2048),
  method: z.enum(['GET', 'HEAD']).optional(),
  headers: z.record(safeString(200), safeString(4096)).optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
});

export const WebSearchSchema = z.strictObject({
  action: z.literal('web_search'),
  query: safeString(1000),
  maxResults: z.number().int().min(1).max(20).optional(),
});

// ── Browser ──────────────────────────────────────────

export const BrowserLaunchSchema = z.strictObject({
  action: z.literal('browser_launch'),
  config: z.strictObject({
    headless: z.boolean().optional(),
    viewport: z.strictObject({
      width: z.number().int().min(320).max(3840).optional(),
      height: z.number().int().min(240).max(2160).optional(),
    }).optional(),
  }).optional(),
});

export const BrowserNavigateSchema = z.strictObject({
  action: z.literal('browser_navigate'),
  session: safeString(128),
  url: z.url().max(2048),
});

export const BrowserSnapshotSchema = z.strictObject({
  action: z.literal('browser_snapshot'),
  session: safeString(128),
});

export const BrowserClickSchema = z.strictObject({
  action: z.literal('browser_click'),
  session: safeString(128),
  ref: z.number().int().min(0),
});

export const BrowserTypeSchema = z.strictObject({
  action: z.literal('browser_type'),
  session: safeString(128),
  ref: z.number().int().min(0),
  text: safeString(10_000),
});

export const BrowserScreenshotSchema = z.strictObject({
  action: z.literal('browser_screenshot'),
  session: safeString(128),
});

export const BrowserCloseSchema = z.strictObject({
  action: z.literal('browser_close'),
  session: safeString(128),
});

// ── Skills ───────────────────────────────────────────

export const SkillReadSchema = z.strictObject({
  action: z.literal('skill_read'),
  name: safeString(200),
});

export const SkillListSchema = z.strictObject({
  action: z.literal('skill_list'),
});

export const SkillProposeSchema = z.strictObject({
  action: z.literal('skill_propose'),
  skill: safeString(200),
  content: safeString(100_000),
  reason: safeString(2000).optional(),
});

// ── Audit ────────────────────────────────────────────

export const AuditQuerySchema = z.strictObject({
  action: z.literal('audit_query'),
  filter: z.strictObject({
    action: safeString(100).optional(),
    sessionId: safeString(128).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).optional(),
});

// ── Agent Delegation ────────────────────────────────

export const AgentDelegateSchema = z.strictObject({
  action: z.literal('agent_delegate'),
  task: safeString(50_000),
  context: safeString(100_000).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  timeoutSec: z.number().int().min(5).max(600).optional(),
});

// ═══════════════════════════════════════════════════════
// Schema registry
// ═══════════════════════════════════════════════════════

export const IPC_SCHEMAS: Record<string, z.ZodType> = {
  llm_call:               LlmCallSchema,
  memory_write:           MemoryWriteSchema,
  memory_query:           MemoryQuerySchema,
  memory_read:            MemoryReadSchema,
  memory_delete:          MemoryDeleteSchema,
  memory_list:            MemoryListSchema,
  web_fetch:              WebFetchSchema,
  web_search:             WebSearchSchema,
  browser_launch:         BrowserLaunchSchema,
  browser_navigate:       BrowserNavigateSchema,
  browser_snapshot:       BrowserSnapshotSchema,
  browser_click:          BrowserClickSchema,
  browser_type:           BrowserTypeSchema,
  browser_screenshot:     BrowserScreenshotSchema,
  browser_close:          BrowserCloseSchema,
  skill_read:             SkillReadSchema,
  skill_list:             SkillListSchema,
  skill_propose:          SkillProposeSchema,
  audit_query:            AuditQuerySchema,
  agent_delegate:         AgentDelegateSchema,
};

export const VALID_ACTIONS = Object.keys(IPC_SCHEMAS);

/**
 * Envelope schema: validates action field is a known action.
 * Checked BEFORE the action-specific schema.
 */
export const IPCEnvelopeSchema = z.object({
  action: z.enum(VALID_ACTIONS as [string, ...string[]]),
}).passthrough();
