import type {
  ServerStatus,
  Agent,
  AuditEntry,
  AuditParams,
  ServerConfig,
  Session,
  StreamEvent,
  DocumentEntry,
  SkillEntry,
  SkillContent,
  WorkspaceFileEntry,
  MemoryEntryView,
  McpServer,
  InstalledPlugin,
  McpTestResult,
  SkillSetupResponse,
  SkillApproveBody,
  SkillApproveResponse,
  CredentialRequestsResponse,
} from './types';

const BASE = '/admin/api';

/** Read the admin token from localStorage. */
export function getToken(): string | null {
  return localStorage.getItem('ax-admin-token');
}

/** Store the admin token in localStorage. */
export function setToken(token: string): void {
  localStorage.setItem('ax-admin-token', token);
}

/** Remove the admin token from localStorage. */
export function clearToken(): void {
  localStorage.removeItem('ax-admin-token');
}

/**
 * Authenticated fetch wrapper.
 * Dispatches an 'ax:auth-required' CustomEvent on 401 responses
 * so the app shell can force a logout.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('ax:auth-required'));
    throw new Error('Authentication required');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Try to extract a human-readable message from the error JSON. If the
    // envelope also carries a `details` string (approve endpoints surface
    // things like the exact unexpected credential name there), hoist it
    // onto the thrown Error so callers can render it.
    let message = res.statusText;
    let details: string | undefined;
    try {
      const parsed = JSON.parse(body);
      message = parsed?.error?.message ?? parsed?.error ?? message;
      if (typeof parsed?.details === 'string') {
        details = parsed.details;
      }
    } catch {
      if (body) message = body;
    }
    const err = new Error(message) as Error & { details?: string };
    if (details) err.details = details;
    throw err;
  }

  return res.json() as Promise<T>;
}

/** API client with typed methods for each endpoint. */
export const api = {
  /** Get server status and health info. */
  status(): Promise<ServerStatus> {
    return apiFetch<ServerStatus>('/status');
  },

  /** List all agents. */
  agents(): Promise<Agent[]> {
    return apiFetch<Agent[]>('/agents');
  },

  /** Get a single agent by ID. */
  agent(id: string): Promise<Agent> {
    return apiFetch<Agent>(`/agents/${encodeURIComponent(id)}`);
  },

  /** Kill (stop) an active agent. */
  killAgent(id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(
      `/agents/${encodeURIComponent(id)}/kill`,
      { method: 'POST' }
    );
  },

  /** Archive (soft-delete) an agent. */
  archiveAgent(id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(
      `/agents/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
  },

  /** Query audit log entries. */
  audit(params?: AuditParams): Promise<AuditEntry[]> {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') {
          qs.set(k, String(v));
        }
      }
    }
    const query = qs.toString();
    return apiFetch<AuditEntry[]>(`/audit${query ? `?${query}` : ''}`);
  },

  /** Get server configuration (read-only). */
  config(): Promise<ServerConfig> {
    return apiFetch<ServerConfig>('/config');
  },

  /** List sessions. */
  sessions(): Promise<Session[]> {
    return apiFetch<Session[]>('/sessions');
  },

  /** List identity documents for an agent. */
  agentIdentity(id: string): Promise<DocumentEntry[]> {
    return apiFetch<DocumentEntry[]>(`/agents/${encodeURIComponent(id)}/identity`);
  },

  /** List skills for an agent. */
  agentSkills(id: string): Promise<SkillEntry[]> {
    return apiFetch<SkillEntry[]>(`/agents/${encodeURIComponent(id)}/skills`);
  },

  /** Read a single skill's content. */
  agentSkillContent(id: string, name: string): Promise<SkillContent> {
    return apiFetch<SkillContent>(`/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`);
  },

  /** Update a skill's content. */
  updateSkill(id: string, name: string, content: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  /** Delete a skill. */
  deleteSkill(id: string, name: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  /** List workspace files for an agent. */
  agentWorkspace(id: string, scope = 'agent'): Promise<WorkspaceFileEntry[]> {
    return apiFetch<WorkspaceFileEntry[]>(`/agents/${encodeURIComponent(id)}/workspace?scope=${scope}`);
  },

  /** List memory entries for an agent. */
  agentMemory(id: string, scope = 'general', limit = 50): Promise<MemoryEntryView[]> {
    return apiFetch<MemoryEntryView[]>(
      `/agents/${encodeURIComponent(id)}/memory?scope=${encodeURIComponent(scope)}&limit=${limit}`
    );
  },

  // ── Global MCP Servers ──

  /** List all global MCP servers. */
  mcpServers(): Promise<McpServer[]> {
    return apiFetch<McpServer[]>('/mcp-servers');
  },

  /** Add a global MCP server. */
  addMcpServer(data: { name: string; url: string; headers?: Record<string, string> }): Promise<McpServer> {
    return apiFetch<McpServer>('/mcp-servers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /** Update a global MCP server. */
  updateMcpServer(name: string, data: { url?: string; headers?: Record<string, string>; enabled?: boolean }): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  /** Remove a global MCP server. */
  removeMcpServer(name: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  /** Test a global MCP server's connectivity. */
  testMcpServer(name: string): Promise<McpTestResult> {
    return apiFetch<McpTestResult>(`/mcp-servers/${encodeURIComponent(name)}/test`, {
      method: 'POST',
    });
  },

  // ── Agent MCP Server Assignment ──

  /** List MCP server names assigned to an agent. */
  agentMcpServers(id: string): Promise<string[]> {
    return apiFetch<string[]>(`/agents/${encodeURIComponent(id)}/mcp-servers`);
  },

  /** Assign a global MCP server to an agent. */
  assignMcpServer(id: string, serverName: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/mcp-servers`, {
      method: 'POST',
      body: JSON.stringify({ serverName }),
    });
  },

  /** Unassign a MCP server from an agent. */
  unassignMcpServer(id: string, serverName: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/mcp-servers/${encodeURIComponent(serverName)}`, {
      method: 'DELETE',
    });
  },

  // ── Agent Plugins ──

  /** List installed plugins for an agent. */
  agentPlugins(id: string): Promise<InstalledPlugin[]> {
    return apiFetch<InstalledPlugin[]>(`/agents/${encodeURIComponent(id)}/plugins`);
  },

  /** Install a plugin for an agent. */
  installPlugin(id: string, source: string): Promise<{ installed: boolean; pluginName?: string; error?: string }> {
    return apiFetch(`/agents/${encodeURIComponent(id)}/plugins`, {
      method: 'POST',
      body: JSON.stringify({ source }),
    });
  },

  /** Uninstall a plugin from an agent. */
  uninstallPlugin(id: string, name: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/plugins/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  // ── Skills (Phase 5) ──

  /** List pending skill setup cards grouped by agent. */
  skillsSetup(): Promise<SkillSetupResponse> {
    return apiFetch<SkillSetupResponse>('/skills/setup');
  },

  /** Approve a pending skill setup card atomically (credentials + domains + reconcile). */
  approveSkill(body: SkillApproveBody): Promise<SkillApproveResponse> {
    return apiFetch<SkillApproveResponse>('/skills/setup/approve', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** Dismiss (remove from dashboard queue) a pending skill setup card. */
  dismissSkill(agentId: string, skillName: string): Promise<{ ok: boolean; removed: boolean }> {
    return apiFetch<{ ok: boolean; removed: boolean }>(
      `/skills/setup/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`,
      { method: 'DELETE' }
    );
  },

  /** List pending ad-hoc credential requests from the request_credential agent tool. */
  credentialRequests(): Promise<CredentialRequestsResponse> {
    return apiFetch<CredentialRequestsResponse>('/credentials/requests');
  },

  /** Provide a credential value for a pending request (drains the queue on success). */
  provideCredential(
    envName: string,
    value: string,
    sessionId?: string
  ): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>('/credentials/provide', {
      method: 'POST',
      body: JSON.stringify({ envName, value, sessionId }),
    });
  },
};

/**
 * Subscribe to Server-Sent Events from the event stream.
 * Returns a cleanup function to close the connection.
 */
export function subscribeEvents(
  onEvent: (event: StreamEvent) => void,
  types?: string[]
): () => void {
  const token = getToken();
  const params = new URLSearchParams();

  if (token) {
    params.set('token', token);
  }
  if (types && types.length > 0) {
    params.set('types', types.join(','));
  }

  const url = `${BASE}/events?${params.toString()}`;
  const source = new EventSource(url);

  source.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as StreamEvent;
      onEvent(event);
    } catch {
      // Ignore malformed events
    }
  };

  source.onerror = () => {
    // EventSource will auto-reconnect.
    // If the server is down, it'll keep retrying.
  };

  return () => {
    source.close();
  };
}
