// src/host/sandbox-tools/types.ts — Shared request/response contracts for sandbox tool execution
//
// Both Tier 1 (WASM) and Tier 2 (container/local) executors implement the
// SandboxToolExecutor interface against these request/response shapes.
// This ensures contract parity regardless of which execution path handles
// a given tool call.

/**
 * Normalized sandbox tool request — the common shape that all executors receive.
 * Created by the sandbox-tools IPC handler from the raw IPC action payload.
 */
export type SandboxToolRequest =
  | SandboxBashRequest
  | SandboxReadFileRequest
  | SandboxWriteFileRequest
  | SandboxEditFileRequest;

export interface SandboxBashRequest {
  type: 'bash';
  command: string;
  timeoutMs?: number;
}

export interface SandboxReadFileRequest {
  type: 'read_file';
  path: string;
}

export interface SandboxWriteFileRequest {
  type: 'write_file';
  path: string;
  content: string;
}

export interface SandboxEditFileRequest {
  type: 'edit_file';
  path: string;
  old_string: string;
  new_string: string;
}

/**
 * Normalized sandbox tool response — the common shape that all executors return.
 * The IPC handler maps these back to the per-action response shapes expected
 * by the agent (e.g., { output } for bash, { content } for read_file).
 */
export type SandboxToolResponse =
  | SandboxBashResponse
  | SandboxReadFileResponse
  | SandboxWriteFileResponse
  | SandboxEditFileResponse;

export interface SandboxBashResponse {
  type: 'bash';
  output: string;
  exitCode?: number;
}

export interface SandboxReadFileResponse {
  type: 'read_file';
  content?: string;
  error?: string;
}

export interface SandboxWriteFileResponse {
  type: 'write_file';
  written: boolean;
  path: string;
  error?: string;
}

export interface SandboxEditFileResponse {
  type: 'edit_file';
  edited: boolean;
  path: string;
  error?: string;
}

/**
 * Execution context passed to executors — workspace location and session metadata.
 */
export interface SandboxExecutionContext {
  /** Absolute path to the session's workspace directory. */
  workspace: string;
  /** Session identifier for audit and affinity. */
  sessionId: string;
  /** Request identifier for per-turn pod affinity (NATS). */
  requestId: string;
}

/**
 * The executor contract. Both local and NATS (and eventually WASM) executors
 * implement this interface. The router picks which executor handles each call.
 */
export interface SandboxToolExecutor {
  /** Human-readable name for audit/logging (e.g., 'local', 'nats', 'wasm'). */
  readonly name: string;

  /** Execute a sandbox tool request and return a normalized response. */
  execute(
    request: SandboxToolRequest,
    context: SandboxExecutionContext,
  ): Promise<SandboxToolResponse>;
}

/**
 * Route decision returned by the intent router.
 */
export interface ToolRoute {
  /** Which tier handles this call: 1 = WASM, 2 = container/local. */
  tier: 1 | 2;
  /** Which executor to use (matches SandboxToolExecutor.name). */
  executor: string;
  /** Audit trail: why this routing decision was made. */
  reason: string;
}
