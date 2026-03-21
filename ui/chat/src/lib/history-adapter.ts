import type { ThreadHistoryAdapter } from '@assistant-ui/react';

/**
 * AX-backed ThreadHistoryAdapter.
 * Loads conversation history from /v1/chat/sessions/:id/history.
 * Append is a no-op since AX server persists turns during chat completions.
 */
export function createAxHistoryAdapter(
  getRemoteId: () => string | undefined,
): ThreadHistoryAdapter {
  return {
    async load() {
      const remoteId = getRemoteId();
      if (!remoteId) return { messages: [] };

      const response = await fetch(`/v1/chat/sessions/${encodeURIComponent(remoteId)}/history`);
      if (!response.ok) {
        if (response.status === 404) return { messages: [] };
        throw new Error('Failed to fetch history');
      }

      const { messages } = await response.json();
      return {
        messages: messages.map((m: any, index: number) => ({
          message: {
            id: `${remoteId}-${index}`,
            role: m.role,
            content: [{ type: 'text' as const, text: m.content }],
            createdAt: m.created_at ? new Date(m.created_at * 1000) : new Date(),
          },
          parentId: index > 0 ? `${remoteId}-${index - 1}` : null,
        })),
      };
    },

    async append() {
      // No-op: AX server persists turns during processCompletion.
    },
  };
}
