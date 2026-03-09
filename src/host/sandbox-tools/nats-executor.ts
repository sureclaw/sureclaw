// src/host/sandbox-tools/nats-executor.ts — NATS-based remote sandbox executor
//
// Dispatches sandbox tool calls to remote sandbox pods via the
// NATSSandboxDispatcher. This is the Tier 2 executor for k8s deployments.

import { getLogger } from '../../logger.js';
import type { NATSSandboxDispatcher } from '../nats-sandbox-dispatch.js';
import type {
  SandboxToolExecutor,
  SandboxToolRequest,
  SandboxToolResponse,
  SandboxExecutionContext,
} from './types.js';
import type {
  SandboxToolRequest as NATSToolRequest,
  SandboxToolResponse as NATSToolResponse,
} from '../../sandbox-worker/types.js';

const logger = getLogger().child({ component: 'nats-executor' });

/**
 * Create a NATS executor that dispatches tool calls to remote sandbox pods.
 */
export function createNATSExecutor(dispatcher: NATSSandboxDispatcher): SandboxToolExecutor {
  return {
    name: 'nats',

    async execute(
      request: SandboxToolRequest,
      context: SandboxExecutionContext,
    ): Promise<SandboxToolResponse> {
      const natsRequest = toNATSRequest(request);

      try {
        logger.info('nats_dispatch_start', {
          requestId: context.requestId,
          toolType: request.type,
        });

        const result = await dispatcher.dispatch(
          context.requestId,
          context.sessionId,
          natsRequest,
        );

        logger.info('nats_dispatch_success', {
          requestId: context.requestId,
          toolType: request.type,
        });

        return fromNATSResponse(request.type, result as NATSToolResponse);
      } catch (err: unknown) {
        logger.error('nats_dispatch_error', {
          requestId: context.requestId,
          toolType: request.type,
          error: (err as Error).message,
        });

        return errorResponse(request.type, `NATS dispatch error: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * Convert a normalized SandboxToolRequest to the NATS wire format.
 */
function toNATSRequest(request: SandboxToolRequest): NATSToolRequest {
  switch (request.type) {
    case 'bash':
      return { type: 'bash', command: request.command, timeoutMs: request.timeoutMs ?? 30_000 };
    case 'read_file':
      return { type: 'read_file', path: request.path };
    case 'write_file':
      return { type: 'write_file', path: request.path, content: request.content };
    case 'edit_file':
      return {
        type: 'edit_file',
        path: request.path,
        old_string: request.old_string,
        new_string: request.new_string,
      };
  }
}

/**
 * Convert a NATS response to the normalized SandboxToolResponse shape.
 */
function fromNATSResponse(
  type: SandboxToolRequest['type'],
  result: NATSToolResponse,
): SandboxToolResponse {
  const r = result as unknown as Record<string, unknown>;
  switch (type) {
    case 'bash':
      return {
        type: 'bash',
        output: (r.output as string) ?? '',
        exitCode: r.exitCode as number | undefined,
      };
    case 'read_file':
      if ('error' in r) return { type: 'read_file', error: r.error as string };
      return { type: 'read_file', content: r.content as string };
    case 'write_file':
      if ('error' in r) return { type: 'write_file', written: false, path: (r.path as string) ?? '', error: r.error as string };
      return { type: 'write_file', written: (r.written as boolean) ?? true, path: (r.path as string) ?? '' };
    case 'edit_file':
      if ('error' in r) return { type: 'edit_file', edited: false, path: (r.path as string) ?? '', error: r.error as string };
      return { type: 'edit_file', edited: (r.edited as boolean) ?? true, path: (r.path as string) ?? '' };
  }
}

/**
 * Create an error response for a given tool type.
 */
function errorResponse(type: SandboxToolRequest['type'], message: string): SandboxToolResponse {
  switch (type) {
    case 'bash':
      return { type: 'bash', output: message };
    case 'read_file':
      return { type: 'read_file', error: message };
    case 'write_file':
      return { type: 'write_file', written: false, path: '', error: message };
    case 'edit_file':
      return { type: 'edit_file', edited: false, path: '', error: message };
  }
}
