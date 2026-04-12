/**
 * @ax/provider-sdk — Provider interface re-exports.
 *
 * This module re-exports every provider interface from the canonical
 * type files so that third-party provider authors can depend on a single
 * package instead of reaching into AX internals.
 *
 * IMPORTANT: These are re-exports, not copies. The source of truth for
 * each interface remains in src/providers/<kind>/types.ts. If you need
 * to add a field, change it there — this file picks it up automatically.
 */

// ── LLM ──────────────────────────────────────────────
export type {
  LLMProvider,
  ChatRequest,
  ChatChunk,
  ToolDef,
  ResolveImageFile,
} from '../../providers/llm/types.js';

// ── Memory ───────────────────────────────────────────
export type {
  MemoryProvider,
  MemoryEntry,
  MemoryQuery,
  ConversationTurn,
  ProactiveHint,
} from '../../providers/memory/types.js';

// ── Security ─────────────────────────────────────────
export type {
  SecurityProvider,
  ScannerProvider,
  ScanTarget,
  ScanResult,
  SkillScreenerProvider,
  ScreeningVerdict,
  ExtendedScreeningVerdict,
} from '../../providers/security/types.js';

// ── Channel ──────────────────────────────────────────
export type {
  ChannelProvider,
  InboundMessage,
  OutboundMessage,
  SessionAddress,
  SessionScope,
  Attachment,
  ChannelAccessConfig,
  DMPolicy,
} from '../../providers/channel/types.js';

// ── Web ──────────────────────────────────────────────
export type {
  WebExtractProvider,
  WebSearchProvider,
  FetchRequest,
  FetchResponse,
  SearchResult,
  ExtractResult,
} from '../../providers/web/types.js';

// ── Credentials ──────────────────────────────────────
export type {
  CredentialProvider,
} from '../../providers/credentials/types.js';

// ── Audit ────────────────────────────────────────────
export type {
  AuditProvider,
  AuditEntry,
  AuditFilter,
} from '../../providers/audit/types.js';

// ── Sandbox ──────────────────────────────────────────
export type {
  SandboxProvider,
  SandboxConfig,
  SandboxProcess,
} from '../../providers/sandbox/types.js';

// ── Scheduler ────────────────────────────────────────
export type {
  SchedulerProvider,
  CronJobDef,
  CronDelivery,
  JobStore,
} from '../../providers/scheduler/types.js';

// ── Shared types ─────────────────────────────────────
export type {
  Config,
  ProviderRegistry,
  Message,
  TaintTag,
  ContentBlock,
  ModelTaskType,
  LLMTaskType,
} from '../../types.js';
