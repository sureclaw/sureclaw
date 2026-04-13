import { createAssistantStream } from 'assistant-stream';
import type { RemoteThreadListAdapter } from '@assistant-ui/react';

/**
 * AX-backed RemoteThreadListAdapter.
 * Fetches and manages threads through /v1/chat/sessions endpoints.
 */
export const axThreadListAdapter: RemoteThreadListAdapter = {
  async list() {
    const response = await fetch('/v1/chat/sessions');
    if (!response.ok) {
      console.error('[AxAdapter] Failed to fetch sessions:', response.status);
      return { threads: [] };
    }

    const { sessions } = await response.json();
    return {
      threads: sessions.map((s: any) => ({
        status: 'regular' as const,
        remoteId: s.id,
        title: s.title ?? undefined,
        externalId: undefined,
      })),
    };
  },

  async fetch(threadId: string) {
    return {
      status: 'regular' as const,
      remoteId: threadId,
      title: undefined,
      externalId: undefined,
    };
  },

  async initialize(threadId: string) {
    // Don't pre-create the session — the AX server auto-creates it
    // during the first completion via chatSessions.ensureExists().
    // The server derives sessionId from the user field: "{agentId}:http:guest:{threadId}".
    return { remoteId: threadId, externalId: undefined };
  },

  async generateTitle(remoteId: string) {
    // The server auto-generates the title during processCompletion.
    // Fetch the session to get the real title (may need a short delay for async generation).
    let title = 'New Chat';
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch('/v1/chat/sessions');
        if (res.ok) {
          const { sessions } = await res.json();
          // Match by exact ID or suffix — the server prefixes session IDs
          // (e.g., "http:dm:{agentId}:{userId}:{threadId}")
          const session = sessions.find((s: any) =>
            s.id === remoteId || s.id.endsWith(`:${remoteId}`),
          );
          if (session?.title) {
            title = session.title;
            break;
          }
        }
      } catch { /* retry */ }
    }
    return createAssistantStream((controller) => {
      controller.appendText(title);
      controller.close();
    });
  },

  // Stubs for future rename/archive/delete
  async rename() {},
  async archive() {},
  async unarchive() {},
  async delete() {},
};
