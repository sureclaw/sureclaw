import { useMemo, useRef } from 'react';
import {
  type AssistantRuntime,
  useRemoteThreadListRuntime,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { useChat } from '@ai-sdk/react';
import { axThreadListAdapter } from './thread-list-adapter';
import { createAxHistoryAdapter } from './history-adapter';
import { AxChatTransport, type CredentialRequiredEvent, type StatusEvent } from './ax-chat-transport';

/**
 * Thread-specific runtime using AI SDK.
 * Passes the AX history adapter directly to useAISDKRuntime
 * so thread history loads when switching threads.
 */
const useChatThreadRuntime = (transport: AxChatTransport): AssistantRuntime => {
  const id = useAuiState(({ threadListItem }) => threadListItem.id);
  const aui = useAui();

  const history = useMemo(
    () => createAxHistoryAdapter(() => aui.threadListItem().getState().remoteId),
    [aui],
  );

  const chat = useChat({ id, transport });
  return useAISDKRuntime(chat, { adapters: { history } });
};

/**
 * Custom hook that creates a chat runtime with AX-backed thread persistence.
 * Returns the runtime and a credential request handler for the modal.
 */
export const useAxChatRuntime = (
  onCredentialRequired?: (event: CredentialRequiredEvent) => void,
  onStatus?: (event: StatusEvent) => void,
): AssistantRuntime => {
  const callbackRef = useRef(onCredentialRequired);
  callbackRef.current = onCredentialRequired;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  const transport = useMemo(
    () =>
      new AxChatTransport({
        api: '/v1/chat/completions',
        onCredentialRequired: (event) => callbackRef.current?.(event),
        onStatus: (event) => statusRef.current?.(event),
      }),
    [],
  );

  return useRemoteThreadListRuntime({
    runtimeHook: () => useChatThreadRuntime(transport),
    adapter: axThreadListAdapter,
  });
};
