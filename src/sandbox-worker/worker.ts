// src/sandbox-worker/worker.ts — NATS-based sandbox worker
//
// Runs inside sandbox pods. Subscribes to tasks.sandbox.{tier} via queue
// group, claims tool tasks, executes them locally, and returns results
// via NATS request/reply.
//
// Lifecycle:
//   1. Worker starts, connects to NATS
//   2. Subscribes to tasks.sandbox.{tier} (queue group: sandbox-{tier}-workers)
//   3. On claim: sets up workspace, creates unique subject sandbox.{podId}
//   4. Subsequent tool calls arrive on sandbox.{podId} via request/reply
//   5. On release: cleans up, re-subscribes to queue group for next claim

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type {
  SandboxClaimRequest,
  SandboxClaimResponse,
  SandboxToolRequest,
  SandboxBashResponse,
  SandboxReadFileResponse,
  SandboxWriteFileResponse,
  SandboxEditFileResponse,
} from './types.js';
import { provisionWorkspace, releaseWorkspace, provisionScope, diffScope, type FileHashMap } from './workspace.js';
import { CANONICAL } from '../providers/sandbox/canonical-paths.js';
import type { SandboxReleaseResponse, FileMeta } from './types.js';

// Default workspace root inside sandbox pods
const WORKSPACE_ROOT = process.env.SANDBOX_WORKSPACE_ROOT ?? '/workspace';

// Default tool execution timeout
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Serialize an object to a NATS message payload.
 */
function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Deserialize a NATS message payload.
 */
function decode<T = unknown>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

/**
 * Resolve a relative path within the workspace.
 * Prevents path traversal by ensuring the resolved path stays within the workspace.
 */
function safeResolve(workspace: string, relativePath: string): string {
  const abs = resolve(workspace, relativePath);
  if (!abs.startsWith(workspace)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return abs;
}

/**
 * Handle a bash tool request.
 */
function handleBash(req: { command: string; cwd?: string; timeoutMs?: number }, workspace: string): SandboxBashResponse {
  const cwd = req.cwd ? safeResolve(workspace, req.cwd) : workspace;
  try {
    // nosemgrep: javascript.lang.security.detect-child-process — sandbox worker: executing sandboxed commands is its purpose
    const out = execSync(req.command, {
      cwd,
      encoding: 'utf-8',
      timeout: req.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { type: 'bash_result', output: out, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n') || 'Command failed';
    return { type: 'bash_result', output: `Exit code ${e.status ?? 1}\n${output}`, exitCode: e.status ?? 1 };
  }
}

/**
 * Handle a read_file tool request.
 */
function handleReadFile(req: { path: string }, workspace: string): SandboxReadFileResponse {
  try {
    const abs = safeResolve(workspace, req.path);
    const content = readFileSync(abs, 'utf-8');
    return { type: 'read_file_result', content };
  } catch (err: unknown) {
    return { type: 'read_file_result', error: `Error reading file: ${(err as Error).message}` };
  }
}

/**
 * Handle a write_file tool request.
 */
function handleWriteFile(req: { path: string; content: string }, workspace: string): SandboxWriteFileResponse {
  try {
    const abs = safeResolve(workspace, req.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, req.content, 'utf-8');
    return { type: 'write_file_result', written: true, path: req.path };
  } catch (err: unknown) {
    return { type: 'write_file_result', written: false, path: req.path, error: `Error writing file: ${(err as Error).message}` };
  }
}

/**
 * Handle an edit_file tool request.
 */
function handleEditFile(req: { path: string; old_string: string; new_string: string }, workspace: string): SandboxEditFileResponse {
  try {
    const abs = safeResolve(workspace, req.path);
    const content = readFileSync(abs, 'utf-8');
    if (!content.includes(req.old_string)) {
      return { type: 'edit_file_result', edited: false, path: req.path, error: 'old_string not found in file' };
    }
    writeFileSync(abs, content.replace(req.old_string, req.new_string), 'utf-8');
    return { type: 'edit_file_result', edited: true, path: req.path };
  } catch (err: unknown) {
    return { type: 'edit_file_result', edited: false, path: req.path, error: `Error editing file: ${(err as Error).message}` };
  }
}

/**
 * Handle a tool request dispatched to a claimed sandbox pod.
 */
function handleToolRequest(req: SandboxToolRequest, workspace: string): unknown {
  switch (req.type) {
    case 'bash':
      return handleBash(req, workspace);
    case 'read_file':
      return handleReadFile(req, workspace);
    case 'write_file':
      return handleWriteFile(req, workspace);
    case 'edit_file':
      return handleEditFile(req, workspace);
    case 'release':
      return { type: 'release_ack' };
    default:
      return { type: 'error', error: `Unknown tool type: ${(req as any).type}` };
  }
}

/**
 * Start the sandbox worker.
 *
 * Connects to NATS and enters a claim/execute/release loop:
 * - Subscribe to tasks.sandbox.{tier} queue group
 * - On claim: set up workspace, subscribe to sandbox.{podId}
 * - Process tool requests on sandbox.{podId}
 * - On release: clean up, re-subscribe to queue group
 */
export async function startWorker(options?: {
  tier?: string;
  natsUrl?: string;
  podId?: string;
}): Promise<{ close: () => Promise<void> }> {
  const natsModule = await import('nats');
  const { connect } = natsModule;

  const tier = options?.tier ?? process.env.SANDBOX_TIER ?? 'light';
  const natsUrl = options?.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';
  const podId = options?.podId ?? process.env.POD_NAME ?? `sandbox-${hostname()}-${randomUUID().slice(0, 8)}`;

  const nc = await connect({
    servers: natsUrl,
    name: `sandbox-worker-${podId}`,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1000,
  });

  console.log(`[sandbox-worker] connected to NATS at ${natsUrl}, podId=${podId}, tier=${tier}`);

  let running = true;
  const taskSubject = `tasks.sandbox.${tier}`;
  const podSubject = `sandbox.${podId}`;
  const queueGroup = `sandbox-${tier}-workers`;

  // Subscribe to task queue for claiming
  const taskSub = nc.subscribe(taskSubject, { queue: queueGroup });

  // Main claim loop
  (async () => {
    for await (const msg of taskSub) {
      if (!running) break;

      let claim: SandboxClaimRequest;
      try {
        claim = decode<SandboxClaimRequest>(msg.data);
      } catch {
        console.error('[sandbox-worker] invalid claim message, skipping');
        continue;
      }

      if (claim.type !== 'claim') {
        console.error(`[sandbox-worker] unexpected message type on task queue: ${claim.type}`);
        continue;
      }

      console.log(`[sandbox-worker] claimed task: requestId=${claim.requestId}, sessionId=${claim.sessionId}`);

      // Provision workspace: try GCS cache → git clone → empty dir
      const wsResult = await provisionWorkspace(WORKSPACE_ROOT, claim.sessionId, claim.workspace);
      const workspace = wsResult.path;
      console.log(`[sandbox-worker] workspace ready: source=${wsResult.source}, durationMs=${wsResult.durationMs}`);

      // Provision workspace scopes (GCS-backed tiers)
      const scopeHashes = new Map<string, FileHashMap>();

      if (claim.scopes?.agent) {
        const result = await provisionScope(
          CANONICAL.agent, claim.scopes.agent.gcsPrefix, claim.scopes.agent.readOnly,
        );
        if (!claim.scopes.agent.readOnly) scopeHashes.set('agent', result.hashes);
        console.log(`[sandbox-worker] agent scope: source=${result.source}, files=${result.fileCount}`);
      }
      if (claim.scopes?.user) {
        const result = await provisionScope(
          CANONICAL.user, claim.scopes.user.gcsPrefix, claim.scopes.user.readOnly,
        );
        if (!claim.scopes.user.readOnly) scopeHashes.set('user', result.hashes);
        console.log(`[sandbox-worker] user scope: source=${result.source}, files=${result.fileCount}`);
      }
      if (claim.scopes?.session) {
        // Session scope backs the scratch workspace with GCS — provision into CANONICAL.scratch
        // so scratch content survives across pod restarts within the same conversation.
        const result = await provisionScope(
          CANONICAL.scratch, claim.scopes.session.gcsPrefix, claim.scopes.session.readOnly,
        );
        if (!claim.scopes.session.readOnly) scopeHashes.set('session', result.hashes);
        console.log(`[sandbox-worker] session scope (scratch): source=${result.source}, files=${result.fileCount}`);
      }

      // Reply with our pod subject so the host can dispatch tool calls directly
      const ack: SandboxClaimResponse = {
        type: 'claim_ack',
        podSubject,
        podId,
      };

      if (msg.reply) {
        msg.respond(encode(ack));
      }

      // Subscribe to our pod-specific subject for tool calls
      const toolSub = nc.subscribe(podSubject);
      let released = false;

      for await (const toolMsg of toolSub) {
        let req: SandboxToolRequest;
        try {
          req = decode<SandboxToolRequest>(toolMsg.data);
        } catch {
          if (toolMsg.reply) {
            toolMsg.respond(encode({ type: 'error', error: 'Invalid tool request' }));
          }
          continue;
        }

        if (req.type === 'release') {
          released = true;

          // Diff scopes and upload changes to GCS staging
          const STAGING_BUCKET = process.env.GCS_WORKSPACE_BUCKET ?? '';
          let staging: SandboxReleaseResponse['staging'];

          if (STAGING_BUCKET && scopeHashes.size > 0) {
            const stagingPrefix = `_staging/${claim.requestId}/`;
            const scopeChanges: Partial<Record<string, FileMeta[]>> = {};

            for (const [scope, hashes] of scopeHashes) {
              const mountPath = scope === 'agent' ? CANONICAL.agent : scope === 'user' ? CANONICAL.user : CANONICAL.scratch;
              const changes = diffScope(mountPath, hashes);
              if (changes.length > 0) {
                for (const change of changes) {
                  if (change.type !== 'deleted') {
                    const localPath = join(mountPath, change.path);
                    const gcsPath = `gs://${STAGING_BUCKET}/${stagingPrefix}${scope}/${change.path}`;
                    // nosemgrep: javascript.lang.security.detect-child-process — sandbox worker: host-constructed paths, not user input
                    execSync(`gsutil -q cp "${localPath}" "${gcsPath}"`, { timeout: 30_000, stdio: 'pipe' });
                  }
                }
                scopeChanges[scope] = changes;
              }
            }

            if (Object.keys(scopeChanges).length > 0) {
              staging = { prefix: stagingPrefix, scopes: scopeChanges };
            }
          }

          if (toolMsg.reply) {
            toolMsg.respond(encode({ type: 'release_ack', staging } satisfies SandboxReleaseResponse));
          }
          toolSub.unsubscribe();
          break;
        }

        const result = handleToolRequest(req, workspace);
        if (toolMsg.reply) {
          toolMsg.respond(encode(result));
        }
      }

      if (!released) {
        toolSub.unsubscribe();
      }

      // Clean up workspace on release (commit/push changes if git repo)
      await releaseWorkspace(workspace, {
        pushChanges: !!claim.workspace?.gitUrl,
        updateCache: !!claim.workspace?.gitUrl,
        cacheKey: claim.workspace?.cacheKey,
      });

      console.log(`[sandbox-worker] released, returning to warm pool`);
    }
  })().catch((err) => {
    if (running) {
      console.error('[sandbox-worker] claim loop error:', err);
    }
  });

  return {
    async close() {
      running = false;
      taskSub.unsubscribe();
      await nc.drain();
    },
  };
}

// If run directly as a standalone process
const isMainModule = process.argv[1]?.endsWith('worker.js') || process.argv[1]?.endsWith('worker.ts');
if (isMainModule) {
  startWorker().catch((err) => {
    console.error('[sandbox-worker] fatal:', err);
    process.exit(1);
  });
}
