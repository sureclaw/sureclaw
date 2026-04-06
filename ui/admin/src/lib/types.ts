/** Server health and status response. */
export interface ServerStatus {
  status: string;
  uptime: number;
  profile: string;
  agents: {
    active: number;
    total: number;
  };
}

/** Agent record returned by the agents API. */
export interface Agent {
  id: string;
  name: string;
  description?: string;
  status: 'running' | 'idle' | 'stopped' | 'error';
  parentId?: string;
  agentType: string;
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  children?: Agent[];
}

/** Single audit log entry. */
export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  action: string;
  args: Record<string, unknown>;
  result: 'ok' | 'error' | 'blocked' | 'timeout';
  durationMs: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
}

/** Server-Sent Event from the event stream. */
export interface StreamEvent {
  type: string;
  requestId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Params for querying audit entries. */
export interface AuditParams {
  action?: string;
  result?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sessionId?: string;
}

/** Session record. */
export interface Session {
  id: string;
  agentId: string;
  startedAt: string;
  endedAt?: string;
  status: string;
}

/** Server configuration (read-only view). */
export interface ServerConfig {
  profile: string;
  providers: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  scheduler: Record<string, unknown>;
  [key: string]: unknown;
}

/** Identity document from the document store. */
export interface DocumentEntry {
  key: string;
  content: string;
}

/** Skill metadata. */
export interface SkillEntry {
  name: string;
  description?: string;
  path: string;
}

/** Skill with content. */
export interface SkillContent {
  name: string;
  content: string;
}

/** Workspace file entry. */
export interface WorkspaceFileEntry {
  path: string;
  size: number;
}

/** Memory entry. */
export interface MemoryEntryView {
  id?: string;
  scope: string;
  content: string;
  tags?: string[];
  createdAt?: string;
  agentId?: string;
}

/** Setup status response. */
export interface SetupStatus {
  configured: boolean;
  auth_disabled?: boolean;
  external_auth?: boolean;
}

/** Setup configuration request. */
export interface SetupRequest {
  profile: string;
  agentType: string;
  apiKey: string;
}

/** Setup configuration response. */
export interface SetupResponse {
  token: string;
}

/** MCP server record. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  headers: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Installed plugin record from admin API. */
export interface InstalledPlugin {
  name: string;
  version: string;
  description: string;
  source: string;
  skills: number;
  commands: number;
  mcpServers: string[];
  installedAt: string;
}

/** MCP server test result. */
export interface McpTestResult {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}
