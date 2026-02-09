// src/providers/types.ts — All provider interfaces and shared types

// ═══════════════════════════════════════════════════════
// Shared Types
// ═══════════════════════════════════════════════════════

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatChunk {
  type: 'text' | 'tool_use' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  usage?: { inputTokens: number; outputTokens: number };
}

export interface MemoryEntry {
  id?: string;
  scope: string;
  content: string;
  tags?: string[];
  taint?: TaintTag;
  createdAt?: Date;
}

export interface MemoryQuery {
  scope: string;
  query?: string;
  limit?: number;
  tags?: string[];
}

export interface ScanTarget {
  content: string;
  source: string;
  taint?: TaintTag;
  sessionId: string;
}

export interface ScanResult {
  verdict: 'PASS' | 'FLAG' | 'BLOCK';
  reason?: string;
  patterns?: string[];
}

export interface TaintTag {
  source: string;
  trust: 'user' | 'external' | 'system';
  timestamp: Date;
}

export interface SandboxConfig {
  workspace: string;
  skills: string;
  ipcSocket: string;
  timeoutSec?: number;
  memoryMB?: number;
  command: string[];
}

export interface SandboxProcess {
  pid: number;
  exitCode: Promise<number>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  kill(): void;
}

export interface InboundMessage {
  id: string;
  channel: string;
  sender: string;
  content: string;
  media?: Buffer;
  timestamp: Date;
  isGroup: boolean;
  groupId?: string;
}

export interface OutboundMessage {
  content: string;
  media?: Buffer;
  replyTo?: string;
}

export interface AuditEntry {
  timestamp: Date;
  sessionId: string;
  action: string;
  args: Record<string, unknown>;
  result: 'success' | 'blocked' | 'error';
  taint?: TaintTag;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
}

export interface AuditFilter {
  action?: string;
  sessionId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface CronJobDef {
  id: string;
  schedule: string;
  agentId: string;
  prompt: string;
  maxTokenBudget?: number;
}

export interface ProactiveHint {
  source: 'memory' | 'pattern' | 'trigger';
  kind: 'pending_task' | 'temporal_pattern' | 'follow_up' | 'anomaly' | 'custom';
  reason: string;
  suggestedPrompt: string;
  confidence: number;
  scope: string;
  memoryId?: string;
  cooldownMinutes?: number;
}

export interface FetchRequest {
  url: string;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  taint: TaintTag;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  taint: TaintTag;
}

export interface BrowserConfig {
  headless?: boolean;
  viewport?: { width?: number; height?: number };
}

export interface BrowserSession {
  id: string;
}

export interface PageSnapshot {
  title: string;
  url: string;
  text: string;
  refs: { ref: number; tag: string; text: string }[];
}

export interface SkillMeta {
  name: string;
  description?: string;
  path: string;
}

export interface SkillProposal {
  skill: string;
  content: string;
  reason?: string;
}

export interface ProposalResult {
  id: string;
  verdict: 'AUTO_APPROVE' | 'NEEDS_REVIEW' | 'REJECT';
  reason: string;
}

export interface LogOptions {
  limit?: number;
  since?: Date;
}

export interface SkillLogEntry {
  id: string;
  skill: string;
  action: 'propose' | 'approve' | 'reject' | 'revert';
  timestamp: Date;
  reason?: string;
}

// ═══════════════════════════════════════════════════════
// Provider Interfaces
// ═══════════════════════════════════════════════════════

export interface LLMProvider {
  name: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  models(): Promise<string[]>;
}

export interface MemoryProvider {
  write(entry: MemoryEntry): Promise<string>;
  query(q: MemoryQuery): Promise<MemoryEntry[]>;
  read(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<void>;
  list(scope: string, limit?: number): Promise<MemoryEntry[]>;
  onProactiveHint?(handler: (hint: ProactiveHint) => void): void;
}

export interface ScannerProvider {
  scanInput(msg: ScanTarget): Promise<ScanResult>;
  scanOutput(msg: ScanTarget): Promise<ScanResult>;
  canaryToken(): string;
  checkCanary(output: string, token: string): boolean;
}

export interface ChannelProvider {
  name: string;
  connect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(target: string, content: OutboundMessage): Promise<void>;
  disconnect(): Promise<void>;
}

export interface WebProvider {
  fetch(req: FetchRequest): Promise<FetchResponse>;
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}

export interface BrowserProvider {
  launch(config: BrowserConfig): Promise<BrowserSession>;
  navigate(session: string, url: string): Promise<void>;
  snapshot(session: string): Promise<PageSnapshot>;
  click(session: string, ref: number): Promise<void>;
  type(session: string, ref: number, text: string): Promise<void>;
  screenshot(session: string): Promise<Buffer>;
  close(session: string): Promise<void>;
}

export interface CredentialProvider {
  get(service: string): Promise<string | null>;
  set(service: string, value: string): Promise<void>;
  delete(service: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface SkillStoreProvider {
  list(): Promise<SkillMeta[]>;
  read(name: string): Promise<string>;
  propose(proposal: SkillProposal): Promise<ProposalResult>;
  approve(proposalId: string): Promise<void>;
  reject(proposalId: string): Promise<void>;
  revert(commitId: string): Promise<void>;
  log(opts?: LogOptions): Promise<SkillLogEntry[]>;
}

export interface AuditProvider {
  log(entry: Partial<AuditEntry>): Promise<void>;
  query(filter: AuditFilter): Promise<AuditEntry[]>;
}

export interface SandboxProvider {
  spawn(config: SandboxConfig): Promise<SandboxProcess>;
  kill(pid: number): Promise<void>;
  isAvailable(): Promise<boolean>;
}

export interface SchedulerProvider {
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  addCron?(job: CronJobDef): void;
  removeCron?(jobId: string): void;
  listJobs?(): CronJobDef[];
  /** Manually trigger cron check at optional Date (for testing). */
  checkCronNow?(at?: Date): void;
  /** Record tokens used so budget tracking can suppress hints. */
  recordTokenUsage?(tokens: number): void;
  /** List hints that were queued (budget exceeded). */
  listPendingHints?(): ProactiveHint[];
}

// ═══════════════════════════════════════════════════════
// Config + Registry
// ═══════════════════════════════════════════════════════

export interface Config {
  profile: 'paranoid' | 'standard' | 'power_user';
  providers: {
    llm: string;
    memory: string;
    scanner: string;
    channels: string[];
    web: string;
    browser: string;
    credentials: string;
    skills: string;
    audit: string;
    sandbox: string;
    scheduler: string;
  };
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
  };
}

export interface ProviderRegistry {
  llm: LLMProvider;
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
}
