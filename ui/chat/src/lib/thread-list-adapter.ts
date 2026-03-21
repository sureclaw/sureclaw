import { createAssistantStream } from 'assistant-stream';
import type { ThreadMessage, RemoteThreadListAdapter } from '@assistant-ui/react';

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

  async generateTitle(_remoteId: string, messages: readonly ThreadMessage[]) {
    // Title is auto-generated server-side during processCompletion.
    // Return a placeholder stream — the real title will appear on next list() refresh.
    const firstUserMessage = messages.find(m => m.role === 'user');
    const textContent = firstUserMessage?.content.find(c => c.type === 'text');
    const text = textContent && 'text' in textContent ? textContent.text : 'New Chat';
    const title = text.length <= 50 ? text : text.substring(0, 47) + '...';

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
