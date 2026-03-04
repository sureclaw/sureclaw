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

/** Setup status response. */
export interface SetupStatus {
  configured: boolean;
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
