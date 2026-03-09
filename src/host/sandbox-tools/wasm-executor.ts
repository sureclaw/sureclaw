// src/host/sandbox-tools/wasm-executor.ts — WASM-based tool executor (Tier 1)
//
// Executes sandbox tool calls through the hostcall validation layer.
// Every operation goes through ToolInvocationContext permission checks,
// safePath validation, quota enforcement, and audit logging.
//
// Phase 0: Operations run natively through the hostcall API layer.
// Phase 1+: Operations will be dispatched to pre-compiled WASM modules
// that call ax.fs.* hostcalls, with Wasmtime/Wasmer providing the
// isolation boundary.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';
import { getNativeHandler, execValidated } from './bash-handlers.js';
import type { BashHandlerContext, HostcallsForBash } from './bash-handlers.js';
import type {
  SandboxToolExecutor,
  SandboxToolRequest,
  SandboxToolResponse,
  SandboxExecutionContext,
} from './types.js';

const logger = getLogger().child({ component: 'wasm-executor' });

/**
 * Per-invocation context created by trusted host code.
 * Captures the permissions, limits, and deadline for a single tool call.
 * The WASM module (or native hostcall layer) cannot modify this.
 */
export interface ToolInvocationContext {
  invocationId: string;
  sessionId: string;
  module: string;
  permissions: {
    fsRead: string[];
    fsWrite: string[];
    maxBytesRead: number;
    maxBytesWrite: number;
  };
  limits: {
    maxMemoryMb: number;
    maxTimeMs: number;
    maxOutputBytes: number;
  };
  deadlineMs: number;
}

/**
 * Default limits for tool invocations.
 */
const DEFAULT_LIMITS = {
  maxBytesRead: 10 * 1024 * 1024,   // 10MB
  maxBytesWrite: 5 * 1024 * 1024,   // 5MB
  maxMemoryMb: 256,
  maxTimeMs: 30_000,
  maxOutputBytes: 1024 * 1024,      // 1MB
};

/**
 * Protected file patterns that hostcalls must reject writes to.
 */
const PROTECTED_PATTERNS = ['.env', '.env.local', '.env.production', 'credentials.json', '.npmrc'];

/**
 * Check if a path matches a protected pattern.
 */
function isProtectedPath(relativePath: string): boolean {
  const segments = relativePath.split(/[/\\]/);
  const filename = segments[segments.length - 1];
  return PROTECTED_PATTERNS.some(p => filename === p || filename.startsWith(p + '.'));
}

/**
 * Validate a path against an allowlist of prefixes.
 * Returns the resolved absolute path if valid, throws otherwise.
 */
function validatePath(
  workspace: string,
  relativePath: string,
  allowedPrefixes: string[],
  operation: string,
): string {
  // safePath handles traversal protection
  // Filter out '.' segments — safePath sanitizes them to '_empty_'
  const segments = relativePath.split(/[/\\]/).filter(s => Boolean(s) && s !== '.');
  if (segments.length === 0) return workspace;
  const abs = safePath(workspace, ...segments);

  // Check against allowed prefixes (if any are specified)
  if (allowedPrefixes.length > 0) {
    const relativeResolved = abs.slice(workspace.length + 1);
    const allowed = allowedPrefixes.some(prefix =>
      relativeResolved === prefix || relativeResolved.startsWith(prefix + '/') || prefix === '*',
    );
    if (!allowed) {
      throw new HostcallError(
        `Permission denied: ${operation} not allowed for path '${relativePath}'`,
        'PERMISSION_DENIED',
      );
    }
  }

  return abs;
}

/**
 * Error thrown by hostcall validation — deterministic policy failure.
 * These must NOT fall back to Tier 2.
 */
export class HostcallError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'HostcallError';
  }
}

/**
 * Hostcall API implementation — the four hostcalls described in the plan.
 * Each hostcall validates against the ToolInvocationContext before executing.
 */
class HostcallAPI {
  private bytesRead = 0;
  private bytesWritten = 0;

  constructor(
    private readonly ctx: ToolInvocationContext,
    private readonly workspace: string,
  ) {}

  /**
   * ax.fs.read(path, offset?, length?) -> { content }
   */
  fsRead(path: string, _offset?: number, _length?: number): { content: string } {
    this.checkDeadline();

    const abs = validatePath(
      this.workspace,
      path,
      this.ctx.permissions.fsRead,
      'read',
    );

    const content = readFileSync(abs, 'utf-8');
    this.bytesRead += Buffer.byteLength(content, 'utf-8');

    if (this.bytesRead > this.ctx.permissions.maxBytesRead) {
      throw new HostcallError(
        `Read quota exceeded: ${this.bytesRead} bytes read, max ${this.ctx.permissions.maxBytesRead}`,
        'QUOTA_EXCEEDED',
      );
    }

    logger.debug('hostcall_fs_read', {
      invocationId: this.ctx.invocationId,
      path,
      bytes: Buffer.byteLength(content, 'utf-8'),
    });

    return { content };
  }

  /**
   * ax.fs.write(path, content, mode) -> { bytesWritten }
   */
  fsWrite(path: string, content: string, _mode: 'overwrite' | 'append' = 'overwrite'): { bytesWritten: number } {
    this.checkDeadline();

    if (isProtectedPath(path)) {
      throw new HostcallError(
        `Write denied: '${path}' is a protected file`,
        'PROTECTED_PATH',
      );
    }

    const abs = validatePath(
      this.workspace,
      path,
      this.ctx.permissions.fsWrite,
      'write',
    );

    const bytes = Buffer.byteLength(content, 'utf-8');
    this.bytesWritten += bytes;

    if (this.bytesWritten > this.ctx.permissions.maxBytesWrite) {
      throw new HostcallError(
        `Write quota exceeded: ${this.bytesWritten} bytes written, max ${this.ctx.permissions.maxBytesWrite}`,
        'QUOTA_EXCEEDED',
      );
    }

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');

    logger.debug('hostcall_fs_write', {
      invocationId: this.ctx.invocationId,
      path,
      bytes,
    });

    return { bytesWritten: bytes };
  }

  /**
   * ax.fs.list(path, recursive?, maxEntries?) -> { entries }
   */
  fsList(
    path: string,
    _recursive = false,
    maxEntries = 10_000,
  ): { entries: Array<{ name: string; type: string; size: number }> } {
    this.checkDeadline();

    const abs = validatePath(
      this.workspace,
      path,
      this.ctx.permissions.fsRead,
      'list',
    );

    const entries: Array<{ name: string; type: string; size: number }> = [];
    const items = readdirSync(abs, { withFileTypes: true });

    for (const item of items) {
      if (entries.length >= maxEntries) break;
      try {
        const s = statSync(`${abs}/${item.name}`);
        entries.push({
          name: item.name,
          type: item.isDirectory() ? 'directory' : 'file',
          size: s.size,
        });
      } catch {
        // skip inaccessible entries
      }
    }

    logger.debug('hostcall_fs_list', {
      invocationId: this.ctx.invocationId,
      path,
      entryCount: entries.length,
    });

    return { entries };
  }

  /**
   * ax.log.emit(level, message, data?) -> void
   */
  logEmit(level: string, message: string, data?: Record<string, unknown>): void {
    logger.info('hostcall_log', {
      invocationId: this.ctx.invocationId,
      module: this.ctx.module,
      level,
      message,
      ...data,
    });
  }

  private checkDeadline(): void {
    if (Date.now() > this.ctx.deadlineMs) {
      throw new HostcallError(
        `Deadline exceeded for invocation ${this.ctx.invocationId}`,
        'DEADLINE_EXCEEDED',
      );
    }
  }
}

/**
 * Create a ToolInvocationContext for a given request and workspace.
 */
function createInvocationContext(
  request: SandboxToolRequest,
  context: SandboxExecutionContext,
): ToolInvocationContext {
  const now = Date.now();
  const module = request.type === 'bash' ? 'bash-readonly' : 'workspace-fs';

  return {
    invocationId: `${context.sessionId}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: context.sessionId,
    module,
    permissions: {
      fsRead: ['*'],  // workspace root — safePath constrains to workspace
      fsWrite: request.type === 'bash' ? [] : ['*'],
      maxBytesRead: DEFAULT_LIMITS.maxBytesRead,
      maxBytesWrite: DEFAULT_LIMITS.maxBytesWrite,
    },
    limits: {
      maxMemoryMb: DEFAULT_LIMITS.maxMemoryMb,
      maxTimeMs: DEFAULT_LIMITS.maxTimeMs,
      maxOutputBytes: DEFAULT_LIMITS.maxOutputBytes,
    },
    deadlineMs: now + DEFAULT_LIMITS.maxTimeMs,
  };
}

/**
 * Create a WASM executor (Tier 1).
 *
 * Phase 0: Runs operations natively through the hostcall validation layer.
 * All file operations go through ToolInvocationContext permission checks,
 * safePath validation, quota enforcement, and audit logging.
 *
 * Phase 1+: Will dispatch to pre-compiled WASM modules that call
 * ax.fs.* hostcalls through registered host functions.
 */
export function createWasmExecutor(): SandboxToolExecutor {
  return {
    name: 'wasm',

    async execute(
      request: SandboxToolRequest,
      context: SandboxExecutionContext,
    ): Promise<SandboxToolResponse> {
      const invCtx = createInvocationContext(request, context);
      const hostcalls = new HostcallAPI(invCtx, context.workspace);

      logger.debug('wasm_execute_start', {
        invocationId: invCtx.invocationId,
        module: invCtx.module,
        type: request.type,
      });

      try {
        const response = executeViaHostcalls(request, hostcalls, context.workspace, invCtx);

        logger.debug('wasm_execute_success', {
          invocationId: invCtx.invocationId,
          module: invCtx.module,
          type: request.type,
        });

        return response;
      } catch (err: unknown) {
        if (err instanceof HostcallError) {
          // Deterministic policy failure — fail closed, do NOT fall back
          logger.warn('wasm_hostcall_denied', {
            invocationId: invCtx.invocationId,
            code: err.code,
            message: err.message,
          });
          return policyErrorResponse(request.type, err.message, request);
        }

        // Runtime error — may be eligible for fallback
        logger.error('wasm_execute_error', {
          invocationId: invCtx.invocationId,
          error: (err as Error).message,
        });
        throw err; // Let the handler decide whether to fall back
      }
    },
  };
}

/**
 * Execute a tool request through the hostcall API.
 * This is the Phase 0 native implementation — in Phase 1+, this will
 * be replaced by WASM module execution with registered host functions.
 */
function executeViaHostcalls(
  request: SandboxToolRequest,
  hostcalls: HostcallAPI,
  workspace: string,
  invCtx: ToolInvocationContext,
): SandboxToolResponse {
  switch (request.type) {
    case 'read_file': {
      try {
        const result = hostcalls.fsRead(request.path);
        return { type: 'read_file', content: result.content };
      } catch (err: unknown) {
        if (err instanceof HostcallError) throw err;
        return { type: 'read_file', error: `Error reading file: ${(err as Error).message}` };
      }
    }

    case 'write_file': {
      try {
        hostcalls.fsWrite(request.path, request.content);
        return { type: 'write_file', written: true, path: request.path };
      } catch (err: unknown) {
        if (err instanceof HostcallError) throw err;
        return { type: 'write_file', written: false, path: request.path, error: `Error writing file: ${(err as Error).message}` };
      }
    }

    case 'edit_file': {
      // Check protected path early — edit_file will write, so block before reading
      if (isProtectedPath(request.path)) {
        throw new HostcallError(
          `Write denied: '${request.path}' is a protected file`,
          'PROTECTED_PATH',
        );
      }
      try {
        const readResult = hostcalls.fsRead(request.path);
        if (!readResult.content.includes(request.old_string)) {
          return { type: 'edit_file', edited: false, path: request.path, error: 'old_string not found in file' };
        }
        const newContent = readResult.content.replace(request.old_string, request.new_string);
        hostcalls.fsWrite(request.path, newContent);
        return { type: 'edit_file', edited: true, path: request.path };
      } catch (err: unknown) {
        if (err instanceof HostcallError) throw err;
        return { type: 'edit_file', edited: false, path: request.path, error: `Error editing file: ${(err as Error).message}` };
      }
    }

    case 'bash': {
      // Phase 2: Route classified bash commands through native handlers where
      // possible. Native handlers use the hostcall API for file access (validation,
      // quotas, audit) and avoid process spawning for simple commands.
      // Commands without native handlers use validated execSync (workspace-contained,
      // timeout-enforced, output-limited).
      const parts = request.command.trim().split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      const hostcallsForBash: HostcallsForBash = {
        fsRead: (path: string) => hostcalls.fsRead(path),
        fsList: (path: string, recursive?: boolean, maxEntries?: number) =>
          hostcalls.fsList(path, recursive, maxEntries),
      };

      const handlerCtx: BashHandlerContext = {
        workspace,
        invocationCtx: invCtx,
        hostcalls: hostcallsForBash,
      };

      const handler = getNativeHandler(cmd);
      if (handler) {
        logger.debug('bash_native_handler', {
          invocationId: invCtx.invocationId,
          command: cmd,
        });
        const result = handler(args, handlerCtx);
        return { type: 'bash', output: result.output, exitCode: result.exitCode };
      }

      // No native handler — use validated execSync for binary commands
      // (rg, grep, find, git, file, tree, du, df)
      logger.debug('bash_validated_exec', {
        invocationId: invCtx.invocationId,
        command: cmd,
      });
      const result = execValidated(request.command, handlerCtx);
      return { type: 'bash', output: result.output, exitCode: result.exitCode };
    }
  }
}

/**
 * Create an error response for a deterministic policy failure.
 * These responses must NOT trigger Tier 2 fallback.
 */
function policyErrorResponse(
  type: SandboxToolRequest['type'],
  message: string,
  request: SandboxToolRequest,
): SandboxToolResponse {
  switch (type) {
    case 'bash':
      return { type: 'bash', output: `Policy error: ${message}` };
    case 'read_file':
      return { type: 'read_file', error: `Policy error: ${message}` };
    case 'write_file':
      return { type: 'write_file', written: false, path: (request as any).path ?? '', error: `Policy error: ${message}` };
    case 'edit_file':
      return { type: 'edit_file', edited: false, path: (request as any).path ?? '', error: `Policy error: ${message}` };
  }
}
