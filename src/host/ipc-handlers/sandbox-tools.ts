/**
 * IPC handlers: sandbox tool operations (sandbox_bash, sandbox_read_file,
 * sandbox_write_file, sandbox_edit_file) and audit gate (sandbox_approve,
 * sandbox_result).
 *
 * In container mode (docker/apple/k8s), the
 * agent executes tools locally inside the container and uses the audit gate
 * for pre-execution approval and post-execution reporting.
 *
 * Every file operation uses safePath() for path containment (SC-SEC-004).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { minimatch } from 'minimatch';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';
import type { GcsFileStorage } from '../gcs-file-storage.js';
import type { FileStore } from '../../file-store.js';

/** Check once whether rg is available on this system. */
let _rgAvailable: boolean | undefined;
function isRgAvailable(): boolean {
  if (_rgAvailable === undefined) {
    try {
      const r = spawnSync('rg', ['--version'], { timeout: 5000 });
      _rgAvailable = r.status === 0;
    } catch {
      _rgAvailable = false;
    }
  }
  return _rgAvailable;
}

/** Recursively walk a directory, yielding file paths. */
function* walkDir(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Compile a user-supplied regex with length guard and error handling. */
function safeRegExp(pattern: string, maxLen = 10_000): RegExp {
  if (pattern.length > maxLen) throw new Error(`Pattern too long (${pattern.length} > ${maxLen})`);
  return new RegExp(pattern);
}

/** Pure Node.js grep fallback — regex match on files. */
function nodeGrep(
  searchPath: string,
  pattern: string,
  opts: { maxResults: number; lineNumbers: boolean; glob?: string },
): { matches: string; truncated: boolean; count: number } {
  const re = safeRegExp(pattern);
  let output = '';
  let count = 0;
  let truncated = false;

  for (const filePath of walkDir(searchPath)) {
    if (truncated) break;
    const relPath = relative(searchPath, filePath);
    if (opts.glob && !minimatch(relPath, opts.glob)) continue;
    let content: string;
    try { content = readFileSync(filePath, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        if (count >= opts.maxResults) { truncated = true; break; }
        const prefix = opts.lineNumbers ? `${relPath}:${i + 1}:` : `${relPath}:`;
        output += (output ? '\n' : '') + prefix + lines[i];
        count++;
      }
    }
  }
  return { matches: output, truncated, count };
}

/** Pure Node.js glob fallback — pattern match on file names. */
function nodeGlob(
  basePath: string,
  pattern: string,
  maxResults: number,
): { files: string[]; truncated: boolean; count: number } {
  const files: string[] = [];
  let truncated = false;
  for (const filePath of walkDir(basePath)) {
    const relPath = relative(basePath, filePath);
    if (minimatch(relPath, pattern, { matchBase: true })) {
      if (files.length >= maxResults) { truncated = true; break; }
      files.push(relPath);
    }
  }
  return { files, truncated, count: files.length };
}

const logger = getLogger().child({ component: 'sandbox-tools' });

/** Extension to MIME type mapping for file uploads. */
const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
  json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  ts: 'text/typescript', svg: 'image/svg+xml', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
};

/** Upload an artifact to GCS and register it in the file store. Returns fileId if uploaded, undefined otherwise. */
async function uploadArtifactIfNeeded(
  path: string,
  content: string,
  opts: SandboxToolHandlerOptions,
  ctx: IPCContext,
): Promise<string | undefined> {
  const isArtifact = path.split(/[/\\]/).filter(Boolean)[0] === 'artifacts';
  if (!isArtifact || !opts.gcsFileStorage) return undefined;

  const ext = path.split('.').pop() ?? '';
  const fileId = `files/${randomUUID()}.${ext}`;
  const buf = Buffer.from(content, 'utf-8');
  const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
  const originalFilename = path.split('/').pop() ?? path;

  await opts.gcsFileStorage.upload(fileId, buf, mimeType, originalFilename);
  await opts.fileStore?.register(fileId, opts.agentName ?? 'main', ctx.userId ?? 'unknown', mimeType, originalFilename);
  opts.onArtifactWritten?.(fileId, mimeType, originalFilename);

  return fileId;
}

export interface SandboxToolHandlerOptions {
  /**
   * Maps sessionId to the workspace directory for that session.
   * Populated by processCompletion() before the agent is spawned,
   * cleaned up after the agent finishes.
   */
  workspaceMap: Map<string, string>;
  /** GCS storage for uploading written files as downloadable artifacts. */
  gcsFileStorage?: GcsFileStorage;
  /** File store for registering file metadata. */
  fileStore?: FileStore;
  /** Agent name for file store registration. */
  agentName?: string;
  /** Callback invoked when a file is written and uploaded to GCS. */
  onArtifactWritten?: (fileId: string, mimeType: string, filename: string) => void;
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

        // Upload to GCS when writing to artifacts/ so the file is downloadable from the chat UI
        const fileId = await uploadArtifactIfNeeded(req.path, req.content, opts, ctx);

        return { written: true, path: req.path, ...(fileId ? { fileId } : {}) };
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

      // Resolve search path within workspace
      const searchPath = req.path
        ? safeWorkspacePath(workspace, req.path)
        : workspace;

      // Fall back to pure Node.js grep if rg is not installed
      if (!isRgAvailable()) {
        const result = nodeGrep(searchPath, req.pattern, {
          maxResults,
          lineNumbers: includeLineNumbers,
          glob: req.glob,
        });
        await providers.audit.log({
          action: 'sandbox_grep',
          sessionId: ctx.sessionId,
          args: { pattern: req.pattern.slice(0, 200), path: req.path },
          result: 'success',
        });
        return result;
      }

      // Build rg command
      const args: string[] = ['--no-heading', '--color', 'never'];
      if (includeLineNumbers) args.push('-n');
      if (contextLines > 0) args.push('-C', String(contextLines));
      if (req.glob) args.push('--glob', req.glob);
      args.push('--', req.pattern);
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

      // Log the exact paths being searched (visible in stderr)
      logger.info('sandbox_glob_paths', {
        sessionId: ctx.sessionId,
        workspace,
        basePath,
        pattern: req.pattern,
      });

      // Fall back to pure Node.js glob if rg is not installed
      if (!isRgAvailable()) {
        const result = nodeGlob(basePath, req.pattern, maxResults);
        logger.debug('sandbox_glob_nodeglob', {
          pattern: req.pattern,
          path: req.path,
          basePath,
          workspace,
          resultCount: result.count,
          truncated: result.truncated,
        });
        await providers.audit.log({
          action: 'sandbox_glob',
          sessionId: ctx.sessionId,
          args: { pattern: req.pattern, path: req.path },
          result: 'success',
        });
        return result;
      }

      // Use rg --files with glob pattern for fast file listing
      const args: string[] = ['--files', '--glob', req.pattern, '--color', 'never'];
      args.push(basePath);

      logger.debug('sandbox_glob_rg_start', {
        pattern: req.pattern,
        path: req.path,
        basePath,
        workspace,
        rgCommand: `rg ${args.join(' ')}`,
      });

      return new Promise<{ files: string[]; truncated: boolean; count: number }>((resolve) => {
        const child = spawn('rg', args, {
          cwd: workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const files: string[] = [];
        let buffer = '';
        let truncated = false;
        let stderrOutput = '';

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

        child.stderr.on('data', (chunk: Buffer) => {
          stderrOutput += chunk.toString('utf-8');
        });

        child.on('close', async (code) => {
          // Process any remaining buffer content
          if (buffer && !truncated && files.length < maxResults) {
            files.push(buffer.startsWith(workspace) ? buffer.slice(workspace.length + 1) : buffer);
          }
          logger.debug('sandbox_glob_rg_done', {
            pattern: req.pattern,
            path: req.path,
            rgExitCode: code,
            resultCount: files.length,
            truncated,
            stderrLength: stderrOutput.length,
            stderrPreview: stderrOutput.substring(0, 200),
          });
          await providers.audit.log({
            action: 'sandbox_glob',
            sessionId: ctx.sessionId,
            args: { pattern: req.pattern, path: req.path },
            result: code === 0 || code === 1 ? 'success' : 'error',
          });
          resolve({ files, truncated, count: files.length });
        });

        child.on('error', async (err) => {
          logger.error('sandbox_glob_rg_error', {
            pattern: req.pattern,
            path: req.path,
            error: (err as Error).message,
          });
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

      // Upload to GCS in container mode when writing to artifacts/
      let fileId: string | undefined;
      if (req.operation === 'write' && req.content && req.path) {
        fileId = await uploadArtifactIfNeeded(req.path, req.content, opts, ctx);
      }

      return { approved: true, ...(fileId ? { fileId } : {}) };
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
