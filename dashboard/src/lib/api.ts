import type {
  ServerStatus,
  Agent,
  AuditEntry,
  AuditParams,
  ServerConfig,
  Session,
  StreamEvent,
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
  });

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('ax:auth-required'));
    throw new Error('Authentication required');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
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
