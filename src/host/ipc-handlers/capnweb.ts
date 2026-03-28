/**
 * IPC handler for Cap'n Web RPC batch requests.
 *
 * The agent sends a single IPC call with the entire Cap'n Web batch payload
 * (newline-delimited JSON messages). The handler processes the batch using
 * Cap'n Web's `newHttpBatchRpcResponse` and returns the response payload.
 *
 * This reuses the existing IPC socket — no separate transport needed.
 */

import { newHttpBatchRpcResponse } from 'capnweb';
import type { RpcTarget } from 'capnweb';
import type { IPCContext } from '../ipc-server.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'capnweb-ipc' });

/**
 * Create Cap'n Web batch IPC handler.
 *
 * @param getTarget - Returns the RpcTarget for the given session.
 *   Called per-request so different sessions can have different tools.
 *   Returns null if Cap'n Web is not configured for this session.
 */
export function createCapnWebHandlers(
  getTarget: (ctx: IPCContext) => RpcTarget | null,
) {
  return {
    capnweb_batch: async (req: { body: string }, ctx: IPCContext) => {
      const target = getTarget(ctx);
      if (!target) {
        throw new Error('Cap\'n Web RPC not available for this session');
      }

      logger.debug('capnweb_batch', { sessionId: ctx.sessionId, bodyLength: req.body.length });

      // Create a synthetic HTTP request from the IPC payload.
      // Cap'n Web's batch protocol is just a POST body in, response body out.
      const request = new Request('http://localhost/rpc', {
        method: 'POST',
        body: req.body,
        headers: { 'Content-Type': 'text/plain' },
      });

      const response = await newHttpBatchRpcResponse(request, target);
      const body = await response.text();

      return { body };
    },
  };
}
