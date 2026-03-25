// src/providers/mcp/activepieces.ts — Activepieces MCP gateway provider
import type { Config, TaintTag } from '../../types.js';
import type {
  McpProvider, McpToolSchema, McpToolCall, McpToolResult, McpCredentialStatus,
} from './types.js';
import { McpAuthRequiredError } from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ActivepiecesConfig {
  url: string;
  healthcheck_interval_ms: number;
  circuit_breaker: {
    failure_threshold: number;
    cooldown_ms: number;
  };
  timeout_ms: number;
}

function resolveConfig(config: Config): ActivepiecesConfig {
  const mcp = config.mcp;
  return {
    url: mcp?.url ?? 'http://localhost:8080',
    healthcheck_interval_ms: mcp?.healthcheck_interval_ms ?? 10_000,
    circuit_breaker: {
      failure_threshold: mcp?.circuit_breaker?.failure_threshold ?? 5,
      cooldown_ms: mcp?.circuit_breaker?.cooldown_ms ?? 30_000,
    },
    timeout_ms: mcp?.timeout_ms ?? 30_000,
  };
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  get isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    // Check if cooldown has elapsed
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.reset();
      return false;
    }
    return true;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
    }
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = 0;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apFetch(
  baseUrl: string,
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs: number },
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Activepieces API ${res.status}: ${text}`);
      (err as any).status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class ActivepiecesMcpProvider implements McpProvider {
  private readonly cfg: ActivepiecesConfig;
  private readonly breaker: CircuitBreaker;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private healthy = true;

  constructor(cfg: ActivepiecesConfig) {
    this.cfg = cfg;
    this.breaker = new CircuitBreaker(
      cfg.circuit_breaker.failure_threshold,
      cfg.circuit_breaker.cooldown_ms,
    );
    this.startHealthCheck();
  }

  // -- Health check ---------------------------------------------------------

  private startHealthCheck(): void {
    if (this.cfg.healthcheck_interval_ms <= 0) return;
    // Fire-and-forget initial check
    void this.checkHealth();
    this.healthTimer = setInterval(() => void this.checkHealth(), this.cfg.healthcheck_interval_ms);
    // Unref so the timer doesn't keep the process alive
    if (typeof this.healthTimer === 'object' && 'unref' in this.healthTimer) {
      this.healthTimer.unref();
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      await apFetch(this.cfg.url, '/api/v1/health', { timeoutMs: 5_000 });
      this.healthy = true;
    } catch {
      this.healthy = false;
    }
  }

  // -- Breaker helpers ------------------------------------------------------

  /** Only record failure for transport errors and 5xx — not client 4xx. */
  private maybeRecordFailure(err: unknown): void {
    const status = (err as any)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) return;
    this.breaker.recordFailure();
  }

  // -- Guard ----------------------------------------------------------------

  private guardCircuit(): void {
    if (this.breaker.isOpen) {
      throw new Error(
        'MCP gateway circuit breaker is open — too many consecutive failures. ' +
        'Retrying after cooldown.',
      );
    }
  }

  // -- McpProvider ----------------------------------------------------------

  async listTools(filter?: { apps?: string[]; query?: string }): Promise<McpToolSchema[]> {
    this.guardCircuit();
    try {
      const params = new URLSearchParams();
      if (filter?.apps?.length) params.set('apps', filter.apps.join(','));
      if (filter?.query) params.set('query', filter.query);
      const qs = params.toString();
      const path = `/api/v1/mcp/tools${qs ? `?${qs}` : ''}`;
      const data = await apFetch(this.cfg.url, path, { timeoutMs: this.cfg.timeout_ms }) as McpToolSchema[];
      this.breaker.reset();
      return data;
    } catch (err) {
      this.maybeRecordFailure(err);
      throw err;
    }
  }

  async callTool(call: McpToolCall): Promise<McpToolResult> {
    this.guardCircuit();
    try {
      const data = await apFetch(this.cfg.url, '/api/v1/mcp/tools/call', {
        method: 'POST',
        body: {
          tool: call.tool,
          arguments: call.arguments,
          agentId: call.agentId,
          userId: call.userId,
          sessionId: call.sessionId,
        },
        timeoutMs: this.cfg.timeout_ms,
      }) as { content: string | Record<string, unknown>; isError?: boolean; authRequired?: McpCredentialStatus };

      this.breaker.reset();

      if (data.authRequired) {
        throw new McpAuthRequiredError(data.authRequired);
      }

      const taint: TaintTag = {
        source: `mcp:${call.tool}`,
        trust: 'external',
        timestamp: new Date(),
      };

      return {
        content: data.content,
        isError: data.isError,
        taint,
      };
    } catch (err) {
      if (err instanceof McpAuthRequiredError) throw err;
      this.maybeRecordFailure(err);
      throw err;
    }
  }

  async credentialStatus(agentId: string, app: string): Promise<McpCredentialStatus> {
    this.guardCircuit();
    try {
      const data = await apFetch(
        this.cfg.url,
        `/api/v1/mcp/credentials/status?agentId=${encodeURIComponent(agentId)}&app=${encodeURIComponent(app)}`,
        { timeoutMs: this.cfg.timeout_ms },
      ) as McpCredentialStatus;
      this.breaker.reset();
      return data;
    } catch (err) {
      this.maybeRecordFailure(err);
      throw err;
    }
  }

  async storeCredential(agentId: string, app: string, value: string): Promise<void> {
    this.guardCircuit();
    try {
      await apFetch(this.cfg.url, '/api/v1/mcp/credentials', {
        method: 'POST',
        body: { agentId, app, value },
        timeoutMs: this.cfg.timeout_ms,
      });
      this.breaker.reset();
    } catch (err) {
      this.maybeRecordFailure(err);
      throw err;
    }
  }

  async listApps(): Promise<Array<{ name: string; description: string; authType: 'oauth' | 'api_key' }>> {
    this.guardCircuit();
    try {
      const data = await apFetch(this.cfg.url, '/api/v1/mcp/apps', {
        timeoutMs: this.cfg.timeout_ms,
      }) as Array<{ name: string; description: string; authType: 'oauth' | 'api_key' }>;
      this.breaker.reset();
      return data;
    } catch (err) {
      this.maybeRecordFailure(err);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function create(config: Config): Promise<McpProvider> {
  const cfg = resolveConfig(config);
  return new ActivepiecesMcpProvider(cfg);
}
