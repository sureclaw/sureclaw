// src/sandbox-worker/types.ts — NATS dispatch protocol for sandbox tool calls
//
// Defines the message types exchanged between the host-side IPC handlers
// and sandbox worker pods via NATS request/reply.

/**
 * Claim request — sent to tasks.sandbox.{tier} queue group.
 * A warm sandbox pod picks this up, sets up workspace, and replies
 * with a SandboxClaimResponse containing the pod's unique subject.
 */
export interface SandboxClaimRequest {
  type: 'claim';
  requestId: string;
  sessionId: string;
  workspace?: {
    gitUrl?: string;
    ref?: string;
    cacheKey?: string;
  };
  /** Workspace tier provisioning -- download from GCS, enforce permissions. */
  scopes?: {
    agent?: { gcsPrefix: string; readOnly: boolean };
    user?: { gcsPrefix: string; readOnly: boolean };
  };
}

/**
 * Response to a claim request — the pod's unique subject for direct dispatch.
 */
export interface SandboxClaimResponse {
  type: 'claim_ack';
  podSubject: string;
  podId: string;
}

/**
 * Bash tool dispatch — sent to sandbox.{podId}.
 */
export interface SandboxBashRequest {
  type: 'bash';
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface SandboxBashResponse {
  type: 'bash_result';
  output: string;
  exitCode?: number;
}

/**
 * Read file dispatch.
 */
export interface SandboxReadFileRequest {
  type: 'read_file';
  path: string;
}

export interface SandboxReadFileResponse {
  type: 'read_file_result';
  content?: string;
  error?: string;
}

/**
 * Write file dispatch.
 */
export interface SandboxWriteFileRequest {
  type: 'write_file';
  path: string;
  content: string;
}

export interface SandboxWriteFileResponse {
  type: 'write_file_result';
  written: boolean;
  path: string;
  error?: string;
}

/**
 * Edit file dispatch.
 */
export interface SandboxEditFileRequest {
  type: 'edit_file';
  path: string;
  old_string: string;
  new_string: string;
}

export interface SandboxEditFileResponse {
  type: 'edit_file_result';
  edited: boolean;
  path: string;
  error?: string;
}

/**
 * Release request — signals the sandbox pod to clean up and return to warm pool.
 */
export interface SandboxReleaseRequest {
  type: 'release';
}

/** Union of all tool requests dispatched to a claimed sandbox pod. */
export type SandboxToolRequest =
  | SandboxBashRequest
  | SandboxReadFileRequest
  | SandboxWriteFileRequest
  | SandboxEditFileRequest
  | SandboxReleaseRequest;

/** Union of all tool responses from a sandbox pod. */
export type SandboxToolResponse =
  | SandboxBashResponse
  | SandboxReadFileResponse
  | SandboxWriteFileResponse
  | SandboxEditFileResponse;

/**
 * Release response — includes GCS staging info for changed workspace tiers.
 */
export interface SandboxReleaseResponse {
  type: 'release_ack';
  /** GCS staging info for changed workspace tiers. */
  staging?: {
    prefix: string;
    scopes: {
      agent?: FileMeta[];
      user?: FileMeta[];
    };
  };
}

export interface FileMeta {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  size: number;
}

/** Union of all messages that can arrive at a sandbox worker. */
export type SandboxMessage = SandboxClaimRequest | SandboxToolRequest;
