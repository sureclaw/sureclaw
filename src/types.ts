// src/types.ts — Shared cross-cutting types
import type { ProfileName } from './onboarding/prompts.js';
import type { LLMProvider } from './providers/llm/types.js';
import type { MemoryProvider } from './providers/memory/types.js';
import type { SecurityProvider } from './providers/security/types.js';
import type { ChannelProvider, ChannelAccessConfig } from './providers/channel/types.js';
import type { WebExtractProvider, WebSearchProvider, FetchRequest, FetchResponse } from './providers/web/types.js';
import type { CredentialProvider } from './providers/credentials/types.js';
import type { AuditProvider } from './providers/audit/types.js';
import type { SandboxProvider } from './providers/sandbox/types.js';
import type { SchedulerProvider, CronDelivery } from './providers/scheduler/types.js';
import type { StorageProvider } from './providers/storage/types.js';
import type { EventBusProvider } from './providers/eventbus/types.js';
import type { DatabaseProvider } from './providers/database/types.js';
import type { McpProvider } from './providers/mcp/types.js';
import type {
  MemoryProviderName, SecurityProviderName, ChannelProviderName,
  WebExtractProviderName, WebSearchProviderName, CredentialProviderName,
  AuditProviderName, SandboxProviderName,
  SchedulerProviderName, StorageProviderName, EventBusProviderName,
  DatabaseProviderName, McpProviderName,
  AuthProviderName, WorkspaceProviderName,
} from './host/provider-map.js';

/** Allowed image MIME types (matches Anthropic vision API). */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];

/** Allowed document MIME types for file attachments. */
export const FILE_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export type FileMimeType = typeof FILE_MIME_TYPES[number];

/** All uploadable MIME types (images + documents). */
export const UPLOAD_MIME_TYPES = [...IMAGE_MIME_TYPES, ...FILE_MIME_TYPES] as const;
export type UploadMimeType = typeof UPLOAD_MIME_TYPES[number];

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; fileId: string; mimeType: ImageMimeType }
  | { type: 'image_data'; data: string; mimeType: ImageMimeType }
  | { type: 'file'; fileId: string; mimeType: string; filename: string }
  | { type: 'file_data'; data: string; mimeType: string; filename: string };

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface TaintTag {
  source: string;
  trust: 'user' | 'external' | 'system';
  timestamp: Date;
}

export type AgentType = 'pi-coding-agent' | 'claude-code';

/** Task types for model routing. All except 'default' are optional and fall back to 'default'. */
export const MODEL_TASK_TYPES = ['default', 'fast', 'thinking', 'coding'] as const;
export type ModelTaskType = typeof MODEL_TASK_TYPES[number];

/** @deprecated LLM_TASK_TYPES is now identical to MODEL_TASK_TYPES since image was removed. */
export const LLM_TASK_TYPES = MODEL_TASK_TYPES;
export type LLMTaskType = ModelTaskType;

/** Per-task-type model map. 'default' is required for router-based agents; optional for claude-code. */
export interface ModelMap {
  default?: string[];
  fast?: string[];
  thinking?: string[];
  coding?: string[];
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
    security: SecurityProviderName;
    channels: ChannelProviderName[];
    web: {
      extract: WebExtractProviderName;
      search: WebSearchProviderName;
    };
    credentials: CredentialProviderName;
    audit: AuditProviderName;
    sandbox: SandboxProviderName;
    scheduler: SchedulerProviderName;
    storage: StorageProviderName;
    database?: DatabaseProviderName;
    eventbus: EventBusProviderName;
    mcp?: McpProviderName;
    auth?: AuthProviderName[];
    workspace?: WorkspaceProviderName;
  };
  channel_config?: Record<string, Partial<ChannelAccessConfig>>;
  sandbox: {
    timeout_sec: number;
    idle_timeout_sec?: number;
    clean_idle_timeout_sec?: number;
    memory_mb: number;
    tiers?: {
      default: { memory_mb: number; cpus: number };
      heavy: { memory_mb: number; cpus: number };
    };
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
    timeout_sec?: number;
    defaultDelivery?: CronDelivery;
  };
  history: {
    max_turns: number;
    thread_context_turns: number;
    summarize: boolean;
    summarize_threshold: number;
    summarize_keep_recent: number;
    memory_recall: boolean;
    memory_recall_limit: number;
    memory_recall_scope: string;
    embedding_model: string;
    embedding_dimensions: number;
  };
  delegation?: {
    max_concurrent?: number;
    max_depth?: number;
  };
  webhooks?: {
    enabled: boolean;
    token: string;
    path?: string;
    max_body_bytes?: number;
    model?: string;
    allowed_agent_ids?: string[];
  };
  admin: {
    enabled: boolean;
    token?: string;
    port: number;
    disable_auth?: boolean;
  };
  auth?: {
    better_auth?: {
      google?: {
        client_id: string;
        client_secret: string;
      };
      allowed_domains?: string[];
    };
  };
  /** Git server configuration for workspace repositories. */
  gitServer?: {
    host: string;
    port?: number;
    httpPort?: number;
    user?: string;
    repoBasePath?: string;
  };
  /** GCS bucket configuration for file storage (artifacts, attachments). */
  gcs?: {
    bucket: string;
    prefix?: string;
  };
  /** Enable HTTP forward proxy for agent outbound HTTP/HTTPS requests. */
  web_proxy?: boolean;
  /** Domains that bypass MITM TLS inspection (cert-pinning CLIs). */
  mitm_bypass_domains?: string[];
  /** K8s namespace for web proxy service discovery. */
  namespace?: string;
  /** Domain-to-URL rewrite map for web proxy (testing/mocking). */
  url_rewrites?: Record<string, string>;
  /** Plugin declarations — each maps a source to the agents that use it. */
  plugins?: PluginDeclaration[];
  /** Shared agents started alongside the default agent. Each has its own Slack token and identity. */
  shared_agents?: SharedAgentConfig[];
}

/** Configuration for a shared (team/company) agent declared in ax.yaml. */
export interface SharedAgentConfig {
  /** Unique agent ID (alphanumeric, dash, underscore). */
  id: string;
  /** Display name shown in Slack responses (e.g. "[Backend Bot]"). */
  display_name: string;
  /** Agent type — defaults to the global config.agent value. */
  agent?: AgentType;
  /** Model overrides for this agent. */
  models?: ModelMap;
  /** Environment variable holding the Slack bot token (e.g. "BACKEND_SLACK_BOT_TOKEN"). */
  slack_bot_token_env?: string;
  /** Environment variable holding the Slack app token (e.g. "BACKEND_SLACK_APP_TOKEN"). */
  slack_app_token_env?: string;
  /** User IDs who can administer this agent. */
  admins?: string[];
  /** Capability tags for routing and discovery. */
  capabilities?: string[];
  /** Brief description of what this agent does. */
  description?: string;
}

export interface PluginDeclaration {
  source: string;
  agents: string[];
}

export interface ProviderRegistry {
  llm: LLMProvider;
  memory: MemoryProvider;
  security: SecurityProvider;
  channels: ChannelProvider[];
  webFetch: { fetch(req: FetchRequest): Promise<FetchResponse> };
  webExtract: WebExtractProvider;
  webSearch: WebSearchProvider;
  credentials: CredentialProvider;
  audit: AuditProvider;
  sandbox: SandboxProvider;
  scheduler: SchedulerProvider;
  storage: StorageProvider;
  database?: DatabaseProvider;
  eventbus: EventBusProvider;
  /** @deprecated Use McpConnectionManager for unified MCP tool discovery and routing. */
  mcp?: McpProvider;
  auth?: import('./providers/auth/types.js').AuthProvider[];
  workspace?: import('./providers/workspace/types.js').WorkspaceProvider;
}
