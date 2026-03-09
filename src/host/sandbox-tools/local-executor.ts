// src/host/sandbox-tools/local-executor.ts — Direct host-side tool execution
//
// Executes sandbox tool calls directly on the host filesystem using the
// session's workspace directory. This is the Tier 2 executor for local
// (non-k8s) deployments.
//
// Every file operation uses safePath() for path containment (SC-SEC-004).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { safePath } from '../../utils/safe-path.js';
import type {
  SandboxToolExecutor,
  SandboxToolRequest,
  SandboxToolResponse,
  SandboxExecutionContext,
} from './types.js';

/**
 * Resolve a relative path within the workspace using safePath().
 * The path is split on forward/backslashes and each segment is passed
 * individually to safePath() for traversal protection.
 */
function safeWorkspacePath(workspace: string, relativePath: string): string {
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  return safePath(workspace, ...segments);
}

/**
 * Create a local executor that runs tool calls directly on the host filesystem.
 */
export function createLocalExecutor(): SandboxToolExecutor {
  return {
    name: 'local',

    async execute(
      request: SandboxToolRequest,
      context: SandboxExecutionContext,
    ): Promise<SandboxToolResponse> {
      switch (request.type) {
        case 'bash':
          return executeBash(request.command, context.workspace, request.timeoutMs);
        case 'read_file':
          return executeReadFile(request.path, context.workspace);
        case 'write_file':
          return executeWriteFile(request.path, request.content, context.workspace);
        case 'edit_file':
          return executeEditFile(request.path, request.old_string, request.new_string, context.workspace);
      }
    },
  };
}

function executeBash(command: string, workspace: string, timeoutMs?: number): SandboxToolResponse {
  try {
    // nosemgrep: javascript.lang.security.detect-child-process — intentional: sandbox tool executes agent commands
    const out = execSync(command, {
      cwd: workspace,
      encoding: 'utf-8',
      timeout: timeoutMs ?? 30_000,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { type: 'bash', output: out, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n') || 'Command failed';
    return { type: 'bash', output: `Exit code ${e.status ?? 1}\n${output}`, exitCode: e.status ?? 1 };
  }
}

function executeReadFile(path: string, workspace: string): SandboxToolResponse {
  try {
    const abs = safeWorkspacePath(workspace, path);
    const content = readFileSync(abs, 'utf-8');
    return { type: 'read_file', content };
  } catch (err: unknown) {
    return { type: 'read_file', error: `Error reading file: ${(err as Error).message}` };
  }
}

function executeWriteFile(path: string, content: string, workspace: string): SandboxToolResponse {
  try {
    const abs = safeWorkspacePath(workspace, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return { type: 'write_file', written: true, path };
  } catch (err: unknown) {
    return { type: 'write_file', written: false, path, error: `Error writing file: ${(err as Error).message}` };
  }
}

function executeEditFile(
  path: string,
  oldString: string,
  newString: string,
  workspace: string,
): SandboxToolResponse {
  try {
    const abs = safeWorkspacePath(workspace, path);
    const content = readFileSync(abs, 'utf-8');
    if (!content.includes(oldString)) {
      return { type: 'edit_file', edited: false, path, error: 'old_string not found in file' };
    }
    writeFileSync(abs, content.replace(oldString, newString), 'utf-8');
    return { type: 'edit_file', edited: true, path };
  } catch (err: unknown) {
    return { type: 'edit_file', edited: false, path, error: `Error editing file: ${(err as Error).message}` };
  }
}
