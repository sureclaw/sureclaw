/**
 * Chat API handler — serves /v1/chat/sessions endpoints
 * for the chat UI thread list and history.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, readBody } from './server-http.js';
import type { StorageProvider } from '../providers/storage/types.js';
import { deserializeContent } from '../utils/content-serialization.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'chat-api' });

function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

export function createChatApiHandler(storage: StorageProvider) {
  return async (req: IncomingMessage, res: ServerResponse, url?: string): Promise<boolean> => {
    const pathname = url ?? req.url?.split('?')[0] ?? '';

    // GET /v1/chat/sessions — list sessions
    if (pathname === '/v1/chat/sessions' && req.method === 'GET') {
      try {
        const sessions = await storage.chatSessions.list();
        sendJSON(res, { sessions });
      } catch (err) {
        logger.error('list_sessions_failed', { error: (err as Error).message });
        sendError(res, 500, 'Failed to list sessions');
      }
      return true;
    }

    // POST /v1/chat/sessions — create session
    if (pathname === '/v1/chat/sessions' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { id, title } = body ? JSON.parse(body) : {};
        const session = await storage.chatSessions.create({ id, title });
        sendJSON(res, session, 201);
      } catch (err) {
        logger.error('create_session_failed', { error: (err as Error).message });
        sendError(res, 400, `Failed to create session: ${(err as Error).message}`);
      }
      return true;
    }

    // DELETE /v1/chat/sessions/:id — delete session
    const deleteMatch = pathname.match(/^\/v1\/chat\/sessions\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      try {
        const sessionId = decodeURIComponent(deleteMatch[1]);
        const deleted = await storage.chatSessions.delete(sessionId);
        if (deleted) {
          res.writeHead(204);
          res.end();
        } else {
          sendError(res, 404, 'Session not found');
        }
      } catch (err) {
        logger.error('delete_session_failed', { error: (err as Error).message });
        sendError(res, 500, 'Failed to delete session');
      }
      return true;
    }

    // GET /v1/chat/sessions/:id/history — get conversation history
    const historyMatch = pathname.match(/^\/v1\/chat\/sessions\/([^/]+)\/history$/);
    if (historyMatch && req.method === 'GET') {
      try {
        const sessionId = decodeURIComponent(historyMatch[1]);
        const turns = await storage.conversations.load(sessionId);
        const messages = turns.map(t => ({
          role: t.role,
          content: deserializeContent(t.content),
          created_at: t.created_at,
        }));
        sendJSON(res, { messages });
      } catch (err) {
        logger.error('get_history_failed', { error: (err as Error).message });
        sendError(res, 500, 'Failed to get history');
      }
      return true;
    }

    return false; // Not handled
  };
}
