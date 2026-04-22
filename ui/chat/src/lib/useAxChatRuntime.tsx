import { useMemo, useRef } from 'react';
import {
  type AssistantRuntime,
  useRemoteThreadListRuntime,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { useChat } from '@ai-sdk/react';
import { generateId } from 'ai';
import { axThreadListAdapter } from './thread-list-adapter';
import { createAxHistoryAdapter } from './history-adapter';
import { AxChatTransport, type StatusEvent, type Diagnostic } from './ax-chat-transport';

/**
 * Thread-specific runtime using AI SDK.
 * Passes the AX history adapter directly to useAISDKRuntime
 * so thread history loads when switching threads.
 */
const useChatThreadRuntime = (transport: AxChatTransport, user = 'guest'): AssistantRuntime => {
  const id = useAuiState(({ threadListItem }) => threadListItem.id);
  const aui = useAui();

  const history = useMemo(
    () => createAxHistoryAdapter(() => aui.threadListItem().getState().remoteId),
    [aui],
  );

  const chat = useChat({ id, transport });
  return useAISDKRuntime(chat, {
    adapters: {
      history,
      attachments: {
        accept: 'image/*,.pdf,.txt,.csv,.md,.json,.xlsx',
        async add({ file }) {
          return {
            id: generateId(),
            type: file.type.startsWith('image/') ? 'image' : 'file',
            name: file.name,
            file,
            contentType: file.type,
            content: [],
            status: { type: 'requires-action' as const, reason: 'composer-send' as const },
          };
        },
        async send(attachment) {
          const EXT_MIME: Record<string, string> = {
            pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
            json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
            html: 'text/html', xml: 'application/xml',
          };
          const ext = attachment.name.split('.').pop()?.toLowerCase() ?? '';
          const mimeType = attachment.contentType || attachment.file.type || EXT_MIME[ext] || 'application/octet-stream';
          const resp = await fetch(`/v1/files?agent=default&user=${encodeURIComponent(user)}&filename=${encodeURIComponent(attachment.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': mimeType },
            body: attachment.file,
          });
          const { fileId } = await resp.json();
          return {
            id: attachment.id,
            type: attachment.type,
            name: attachment.name,
            contentType: mimeType,
            status: { type: 'complete' as const },
            content: mimeType.startsWith('image/')
              ? [{ type: 'image' as const, image: fileId }]
              : [{ type: 'file' as const, data: fileId, mimeType, filename: attachment.name }],
          };
        },
        async remove() {},
      },
    },
  });
};

/**
 * Custom hook that creates a chat runtime with AX-backed thread persistence.
 */
export const useAxChatRuntime = (
  onStatus?: (event: StatusEvent) => void,
  onRunStart?: () => void,
  user?: string,
  onDiagnostic?: (d: Diagnostic) => void,
): AssistantRuntime => {
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const runStartRef = useRef(onRunStart);
  runStartRef.current = onRunStart;
  const diagnosticRef = useRef(onDiagnostic);
  diagnosticRef.current = onDiagnostic;

  const transport = useMemo(
    () =>
      new AxChatTransport({
        api: '/v1/chat/completions',
        user,
        onStatus: (event) => statusRef.current?.(event),
        onRunStart: () => runStartRef.current?.(),
        onDiagnostic: (d) => diagnosticRef.current?.(d),
      }),
    [user],
  );

  return useRemoteThreadListRuntime({
    runtimeHook: () => useChatThreadRuntime(transport, user ?? 'guest'),
    adapter: axThreadListAdapter,
  });
};
