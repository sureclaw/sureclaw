/**
 * IPC handlers: sandbox tool operations (sandbox_bash, sandbox_read_file,
 * sandbox_write_file, sandbox_edit_file) and audit gate (sandbox_approve,
 * sandbox_result).
 *
 * In subprocess mode these execute directly on the host filesystem using the
 * session's workspace directory. In container mode (docker/apple/k8s), the
 * agent executes tools locally inside the container and uses the audit gate
 * for pre-execution approval and post-execution reporting.
 *
 * Every file operation uses safePath() for path containment (SC-SEC-004).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'sandbox-tools' });

export interface SandboxToolHandlerOptions {
  /**
   * Maps sessionId to the workspace directory for that session.
   * Populated by processCompletion() before the agent is spawned,
   * cleaned up after the agent finishes.
   */
  workspaceMap: Map<string, string>;
}

function resolveWorkspace(opts: SandboxToolHandlerOptions, ctx: IPCContext): string {
  const workspace = opts.workspaceMap.get(ctx.sessionId);
  if (!workspace) {
    throw new Error(`No workspace registered for session "${ctx.sessionId}"`);
  }
  return workspace;
}

/**
 * Resolve a relative path within the workspace using safePath().
 * The path is split on forward/backslashes and each segment is passed
 * individually to safePath() for traversal protection.
 */
function safeWorkspacePath(workspace: string, relativePath: string): string {
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  return safePath(workspace, ...segments);
}

export function createSandboxToolHandlers(providers: ProviderRegistry, opts: SandboxToolHandlerOptions) {
  return {
    sandbox_bash: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const TIMEOUT_MS = 120_000;
      const MAX_BUFFER = 1024 * 1024;

      return new Promise<{ output: string }>((resolve) => {
        // nosemgrep: javascript.lang.security.detect-child-process — intentional: sandbox tool
        const child = spawn('sh', ['-c', req.command], {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_BUFFER) stdout += chunk.toString('utf-8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_BUFFER) stderr += chunk.toString('utf-8');
        });

        const killGroup = (signal: NodeJS.Signals) => {
          try { process.kill(-child.pid!, signal); } catch { /* already dead */ }
        };

        const timer = setTimeout(() => {
          killed = true;
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 5_000);
        }, TIMEOUT_MS);

        child.on('close', async (code) => {
          clearTimeout(timer);
          const exitCode = code ?? (killed ? 124 : 1);
          const output = exitCode === 0
            ? stdout
            : [stdout, stderr].filter(Boolean).join('\n') || (killed ? 'Command timed out' : 'Command failed');

          await providers.audit.log({
            action: 'sandbox_bash',
            sessionId: ctx.sessionId,
            args: { command: req.command.slice(0, 200) },
            result: exitCode === 0 ? 'success' : 'error',
          });
          resolve(exitCode === 0 ? { output } : { output: `Exit code ${exitCode}\n${output}` });
        });

        child.on('error', async (err) => {
          clearTimeout(timer);
          await providers.audit.log({
            action: 'sandbox_bash',
            sessionId: ctx.sessionId,
            args: { command: req.command.slice(0, 200) },
            result: 'error',
          });
          resolve({ output: `Exit code 1\nCommand error: ${err.message}` });
        });
      });
    },

    sandbox_read_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        const abs = safeWorkspacePath(workspace, req.path);
        const content = readFileSync(abs, 'utf-8');
        await providers.audit.log({
          action: 'sandbox_read_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'success',
        });
        return { content };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_read_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error reading file: ${(err as Error).message}` };
      }
    },

    sandbox_write_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        const abs = safeWorkspacePath(workspace, req.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, req.content, 'utf-8');
        await providers.audit.log({
          action: 'sandbox_write_file',
          sessionId: ctx.sessionId,
          args: { path: req.path, bytes: req.content.length },
          result: 'success',
        });
        return { written: true, path: req.path };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_write_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error writing file: ${(err as Error).message}` };
      }
    },

    sandbox_edit_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        const abs = safeWorkspacePath(workspace, req.path);
        const content = readFileSync(abs, 'utf-8');
        if (!content.includes(req.old_string)) {
          return { error: 'old_string not found in file' };
        }
        writeFileSync(abs, content.replace(req.old_string, req.new_string), 'utf-8');
        await providers.audit.log({
          action: 'sandbox_edit_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'success',
        });
        return { edited: true, path: req.path };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_edit_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error editing file: ${(err as Error).message}` };
      }
    },

    sandbox_grep: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const maxResults = req.max_results ?? 100;
      const includeLineNumbers = req.include_line_numbers !== false;
      const contextLines = req.context_lines ?? 0;

      // Build rg command
      const args: string[] = ['--no-heading', '--color', 'never'];
      if (includeLineNumbers) args.push('-n');
      if (contextLines > 0) args.push('-C', String(contextLines));
      if (req.glob) args.push('--glob', req.glob);
      args.push('--', req.pattern);

      // Resolve search path within workspace
      const searchPath = req.path
        ? safeWorkspacePath(workspace, req.path)
        : workspace;
      args.push(searchPath);

      return new Promise<{ matches: string; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let output = '';
        let lineCount = 0;
        let truncated = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const text = chunk.toString('utf-8');
          const lines = text.split('\n');
          for (const line of lines) {
            if (lineCount >= maxResults) {
              truncated = true;
              return;
            }
            if (line || lineCount > 0) {
              output += (output ? '\n' : '') + line;
              if (line) lineCount++;
            }
          }
        });

        child.on('close', async (code) => {
          await providers.audit.log({
            action: 'sandbox_grep',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern.slice(0, 200), path: req.path },
            result: code === 0 || code === 1 ? 'success' : 'error',
          });
          // rg exits 1 for "no matches" — that's not an error
          resolve({ matches: output, truncated, count: lineCount });
        });

        child.on('error', async (err) => {
          await providers.audit.log({
            action: 'sandbox_grep',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern.slice(0, 200) },
            result: 'error',
          });
          resolve({ matches: `Error: ${err.message}`, truncated: false, count: 0 });
        });
      });
    },

    sandbox_glob: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      const maxResults = req.max_results ?? 100;

      // Resolve base path within workspace
      const basePath = req.path
        ? safeWorkspacePath(workspace, req.path)
        : workspace;

      // Use rg --files with glob pattern for fast file listing
      const args: string[] = ['--files', '--glob', req.pattern, '--color', 'never'];
      args.push(basePath);

      return new Promise<{ files: string[]; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const files: string[] = [];
        let buffer = '';
        let truncated = false;

        child.stdout.on('data', (chunk: Buffer) => {
          if (truncated) return;
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            if (files.length >= maxResults) {
              truncated = true;
              return;
            }
            // Return relative paths from workspace root
            files.push(line.startsWith(workspace) ? line.slice(workspace.length + 1) : line);
          }
        });

        child.on('close', async (code) => {
          // Process any remaining buffer content
          if (buffer && !truncated && files.length < maxResults) {
            files.push(buffer.startsWith(workspace) ? buffer.slice(workspace.length + 1) : buffer);
          }
          await providers.audit.log({
            action: 'sandbox_glob',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern, path: req.path },
            result: code === 0 || code === 1 ? 'success' : 'error',
          });
          resolve({ files, truncated, count: files.length });
        });

        child.on('error', async (err) => {
          await providers.audit.log({
            action: 'sandbox_glob',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern },
            result: 'error',
          });
          resolve({ files: [], truncated: false, count: 0 });
        });
      });
    },

    // ── Sandbox Audit Gate (container-local execution) ──────────

    sandbox_approve: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({
        action: `sandbox_${req.operation}`,
        sessionId: ctx.sessionId,
        args: {
          ...(req.command ? { command: req.command.slice(0, 200) } : {}),
          ...(req.path ? { path: req.path } : {}),
          mode: 'container-local',
        },
        result: 'success',
      });
      logger.debug('sandbox_approve', {
        sessionId: ctx.sessionId,
        operation: req.operation,
        ...(req.command ? { command: req.command.slice(0, 100) } : {}),
        ...(req.path ? { path: req.path } : {}),
      });
      // Option A+ hook point: policy check, return {approved: false, reason: "..."}

      return { approved: true };
    },

    sandbox_result: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({
        action: `sandbox_${req.operation}_result`,
        sessionId: ctx.sessionId,
        args: {
          ...(req.command ? { command: req.command.slice(0, 200) } : {}),
          ...(req.path ? { path: req.path } : {}),
          ...(req.exitCode !== undefined ? { exitCode: req.exitCode } : {}),
          ...(req.success !== undefined ? { success: req.success } : {}),
          mode: 'container-local',
        },
        result: (req.exitCode === 0 || req.success) ? 'success' : 'error',
      });
      return { ok: true };
    },

  };
}
