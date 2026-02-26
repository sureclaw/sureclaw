// src/types.ts — Shared cross-cutting types
import type { ProfileName } from './onboarding/prompts.js';
import type { LLMProvider } from './providers/llm/types.js';
import type { ImageProvider } from './providers/image/types.js';
import type { MemoryProvider } from './providers/memory/types.js';
import type { ScannerProvider } from './providers/scanner/types.js';
import type { ChannelProvider, ChannelAccessConfig } from './providers/channel/types.js';
import type { WebProvider } from './providers/web/types.js';
import type { BrowserProvider } from './providers/browser/types.js';
import type { CredentialProvider } from './providers/credentials/types.js';
import type { SkillStoreProvider, SkillScreenerProvider } from './providers/skills/types.js';
import type { AuditProvider } from './providers/audit/types.js';
import type { SandboxProvider } from './providers/sandbox/types.js';
import type { SchedulerProvider, CronDelivery } from './providers/scheduler/types.js';
import type {
  MemoryProviderName, ScannerProviderName, ChannelProviderName,
  WebProviderName, BrowserProviderName, CredentialProviderName,
  SkillsProviderName, AuditProviderName, SandboxProviderName,
  SchedulerProviderName,
} from './host/provider-map.js';

/** Allowed image MIME types (matches Anthropic vision API). */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; fileId: string; mimeType: ImageMimeType }
  | { type: 'image_data'; data: string; mimeType: ImageMimeType };

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface TaintTag {
  source: string;
  trust: 'user' | 'external' | 'system';
  timestamp: Date;
}

export type AgentType = 'pi-agent-core' | 'pi-coding-agent' | 'claude-code';

/** Task types for model routing. All except 'default' are optional and fall back to 'default'. */
export const MODEL_TASK_TYPES = ['default', 'fast', 'thinking', 'coding', 'image'] as const;
export type ModelTaskType = typeof MODEL_TASK_TYPES[number];

/** LLM-only task types (everything except 'image', which goes to the image router). */
export const LLM_TASK_TYPES = ['default', 'fast', 'thinking', 'coding'] as const;
export type LLMTaskType = typeof LLM_TASK_TYPES[number];

/** Per-task-type model map. 'default' is required; all others fall back to it when missing. */
export interface ModelMap {
  default: string[];
  fast?: string[];
  thinking?: string[];
  coding?: string[];
  image?: string[];
}

export interface Config {
  agent?: AgentType;
  /** Enterprise agent name — used for registry and workspace paths. Defaults to 'main'. */
  agent_name?: string;
  models?: ModelMap;
  max_tokens?: number;
  profile: ProfileName;
  providers: {
    memory: MemoryProviderName;
    scanner: ScannerProviderName;
    channels: ChannelProviderName[];
    web: WebProviderName;
    browser: BrowserProviderName;
    credentials: CredentialProviderName;
    skills: SkillsProviderName;
    audit: AuditProviderName;
    sandbox: SandboxProviderName;
    scheduler: SchedulerProviderName;
    skillScreener?: string;
  };
  channel_config?: Record<string, Partial<ChannelAccessConfig>>;
  sandbox: {
    timeout_sec: number;
    memory_mb: number;
  };
  scheduler: {
    active_hours: {
      start: string;
      end: string;
      timezone: string;
    };
    max_token_budget: number;
    heartbeat_interval_min: number;
    proactive_hint_confidence_threshold?: number;
    proactive_hint_cooldown_sec?: number;
    agent_dir?: string;
    defaultDelivery?: CronDelivery;
  };
  history: {
    max_turns: number;
    thread_context_turns: number;
  };
  delegation?: {
    max_concurrent?: number;
    max_depth?: number;
  };
}

export interface ProviderRegistry {
  llm: LLMProvider;
  image?: ImageProvider;
  memory: MemoryProvider;
  scanner: ScannerProvider;
  channels: ChannelProvider[];
  web: WebProvider;
  browser: BrowserProvider;
  credentials: CredentialProvider;
  skills: SkillStoreProvider;
  audit: AuditProvider;
  sandbox: SandboxProvider;
  scheduler: SchedulerProvider;
  skillScreener?: SkillScreenerProvider;
}
