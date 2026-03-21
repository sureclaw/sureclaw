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
    // The server derives sessionId from the user field: "main:http:chat-ui:{threadId}".
    return { remoteId: threadId, externalId: undefined };
  },

  async generateTitle() {
    // Title is auto-generated server-side during processCompletion.
    // Return a neutral placeholder — the real title will appear on next list() refresh.
    return createAssistantStream((controller) => {
      controller.appendText('New Chat');
      controller.close();
    });
  },

  // Stubs for future rename/archive/delete
  async rename() {},
  async archive() {},
  async unarchive() {},
  async delete() {},
};
