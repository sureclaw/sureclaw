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
    const response = await fetch('/v1/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: threadId }),
    });

    if (!response.ok) {
      throw new Error('Failed to create session');
    }

    const session = await response.json();
    return { remoteId: session.id, externalId: undefined };
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
