/**
 * In-process server test harness.
 *
 * Boots a real AX server inside the test process with mock providers,
 * provides HTTP helpers for sending messages, and cleans up on dispose.
 *
 * Usage:
 *   const h = await createHarness({ llm: myScriptableLLM, sandbox: myMockSandbox });
 *   const res = await h.sendMessage('Hello');
 *   expect(res.parsed.choices[0].message.content).toContain('Hi');
 *   await h.dispose();
 */

import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';

import { initLogger, resetLogger } from '../../src/logger.js';
import { loadConfig } from '../../src/config.js';
import { createServer, type AxServer } from '../../src/host/server-local.js';
import type { Config, ProviderRegistry } from '../../src/types.js';
import type { LLMProvider } from '../../src/providers/llm/types.js';
import type { SandboxProvider } from '../../src/providers/sandbox/types.js';
import type { WebProvider } from '../../src/providers/web/types.js';
import type { WorkspaceProvider } from '../../src/providers/workspace/types.js';
import { createMockWeb, createMockGcsBucket } from './mock-providers.js';
import type { GcsBucketLike } from '../../src/providers/workspace/gcs.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface HarnessOptions {
  /** LLM provider (required — use createScriptableLLM or a custom mock). */
  llm: LLMProvider;

  /** Sandbox provider (required — use a mock that captures spawns). */
  sandbox: SandboxProvider;

  /** Web provider (optional — defaults to createMockWeb()). */
  web?: WebProvider;

  /** Full config YAML override (replaces the default config). */
  configYaml?: string;

  /**
   * Additional provider overrides merged on top of the harness defaults.
   * Use this for workspace, memory, scanner, etc.
   */
  providerOverrides?: Partial<ProviderRegistry>;

  /** Hook called after config is loaded but before server.start(). */
  preStart?: (config: Config, home: string) => void | Promise<void>;

  /** TCP port for the server (enables TCP listener alongside Unix socket). */
  port?: number;

  /**
   * Use an existing AX_HOME directory instead of creating a temp one.
   * Useful for identity persistence tests across harness lifetimes.
   * The directory will NOT be deleted on dispose.
   */
  existingHome?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
  parsed: Record<string, unknown>;
}

export interface ServerHarness {
  /** The underlying AxServer instance. */
  server: AxServer;

  /** Path to the AX_HOME temp directory. */
  home: string;

  /** Path to the Unix socket the server listens on. */
  socket: string;

  /** TCP port if configured, undefined otherwise. */
  port: number | undefined;

  /** Mock GCS bucket (available for workspace assertions). */
  gcsBucket: GcsBucketLike & { files: Map<string, Buffer> };

  /**
   * Send a single user message via the OpenAI-compatible HTTP API.
   * Returns the parsed response.
   */
  sendMessage(content: string, opts?: {
    sessionId?: string;
    user?: string;
    model?: string;
    stream?: boolean;
  }): Promise<HttpResponse>;

  /**
   * Send a full messages array (for multi-turn conversations).
   * Returns the parsed response.
   */
  sendMessages(messages: Array<{ role: string; content: string }>, opts?: {
    sessionId?: string;
    user?: string;
    model?: string;
    stream?: boolean;
  }): Promise<HttpResponse>;

  /** Read a file relative to AX_HOME. */
  readFile(relativePath: string): string;

  /** Write a file relative to AX_HOME. */
  writeFile(relativePath: string, content: string): void;

  /** Check if a file exists relative to AX_HOME. */
  fileExists(relativePath: string): boolean;

  /** Stop the server, restore AX_HOME, and clean up the temp directory. */
  dispose(): Promise<void>;
}

// ═══════════════════════════════════════════════════════
// Default config
// ═══════════════════════════════════════════════════════

const DEFAULT_CONFIG_YAML = `\
profile: paranoid
models:
  default:
    - mock/default
providers:
  memory: cortex
  scanner: guardian
  channels: []
  web: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: plainjob
  storage: database
  eventbus: inprocess
  workspace: local
  screener: static
sandbox:
  timeout_sec: 60
  memory_mb: 256
scheduler:
  active_hours:
    start: "00:00"
    end: "23:59"
    timezone: "UTC"
  max_token_budget: 4096
  heartbeat_interval_min: 30
admin:
  enabled: false
`;

// ═══════════════════════════════════════════════════════
// HTTP helper
// ═══════════════════════════════════════════════════════

/**
 * Make an HTTP request to the server over Unix socket or TCP.
 * Returns { status, body, parsed }.
 */
function httpPost(
  path: string,
  payload: unknown,
  target: { socketPath: string } | { host: string; port: number },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);

    const options: Record<string, unknown> = {
      method: 'POST',
      path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    if ('socketPath' in target) {
      options.socketPath = target.socketPath;
    } else {
      options.hostname = target.host;
      options.port = target.port;
    }

    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // Body may not be valid JSON (e.g. error responses)
        }
        resolve({
          status: res.statusCode ?? 0,
          body,
          parsed,
        });
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
// Harness factory
// ═══════════════════════════════════════════════════════

export async function createHarness(opts: HarnessOptions): Promise<ServerHarness> {
  // Save and override AX_HOME
  const originalAxHome = process.env.AX_HOME;
  const ownsHome = !opts.existingHome;
  const home = opts.existingHome ?? mkdtempSync(join(tmpdir(), 'ax-test-'));
  process.env.AX_HOME = home;

  // Create required directory structure
  mkdirSync(join(home, 'data'), { recursive: true });
  mkdirSync(join(home, 'agents', 'main', 'agent', 'identity'), { recursive: true });
  mkdirSync(join(home, 'agents', 'main', 'agent', 'skills'), { recursive: true });

  // Write config YAML
  const configYaml = opts.configYaml ?? DEFAULT_CONFIG_YAML;
  writeFileSync(join(home, 'ax.yaml'), configYaml, 'utf-8');

  // Initialize logger in silent mode (no console, no file)
  resetLogger();
  initLogger({ file: false, level: 'silent' });

  // Load config from the temp home
  const config = loadConfig(join(home, 'ax.yaml'));

  // Build mock GCS bucket (for workspace assertions even if not used)
  const gcsBucket = createMockGcsBucket();

  // Build provider overrides
  const web = opts.web ?? createMockWeb();
  const providerOverrides: Partial<ProviderRegistry> = {
    llm: opts.llm,
    sandbox: opts.sandbox,
    web,
    ...opts.providerOverrides,
  };

  // Pre-start hook
  if (opts.preStart) {
    await opts.preStart(config, home);
  }

  // Determine socket path
  const socketPath = join(home, 'ax.sock');

  // Create and start the server
  const server = await createServer(config, {
    socketPath,
    port: opts.port,
    providerOverrides,
  });

  await server.start();

  // Determine the HTTP target for requests
  const target: { socketPath: string } | { host: string; port: number } =
    opts.port != null && server.tcpAddress
      ? { host: server.tcpAddress.host, port: server.tcpAddress.port }
      : { socketPath };

  // ── Public API ──

  function sendMessage(
    content: string,
    msgOpts?: {
      sessionId?: string;
      user?: string;
      model?: string;
      stream?: boolean;
    },
  ): Promise<HttpResponse> {
    return sendMessages(
      [{ role: 'user', content }],
      msgOpts,
    );
  }

  function sendMessages(
    messages: Array<{ role: string; content: string }>,
    msgOpts?: {
      sessionId?: string;
      user?: string;
      model?: string;
      stream?: boolean;
    },
  ): Promise<HttpResponse> {
    const payload: Record<string, unknown> = {
      messages,
      stream: msgOpts?.stream ?? false,
    };
    if (msgOpts?.sessionId) payload.session_id = msgOpts.sessionId;
    if (msgOpts?.user) payload.user = msgOpts.user;
    if (msgOpts?.model) payload.model = msgOpts.model;

    return httpPost('/v1/chat/completions', payload, target);
  }

  function readFile(relativePath: string): string {
    return readFileSync(join(home, relativePath), 'utf-8');
  }

  function writeFile(relativePath: string, content: string): void {
    const fullPath = join(home, relativePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }

  function fileExists(relativePath: string): boolean {
    return existsSync(join(home, relativePath));
  }

  async function dispose(): Promise<void> {
    // Stop the server
    try {
      await server.stop();
    } catch {
      // Best-effort — server may already be stopped
    }

    // Restore AX_HOME
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }

    // Reset logger so future tests get a fresh one
    resetLogger();

    // Clean up temp directory (only if we created it)
    if (ownsHome) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  return {
    server,
    home,
    socket: socketPath,
    port: opts.port,
    gcsBucket,
    sendMessage,
    sendMessages,
    readFile,
    writeFile,
    fileExists,
    dispose,
  };
}
