import { useMemo } from 'react';
import {
  type AssistantRuntime,
  useRemoteThreadListRuntime,
  useAui,
  RuntimeAdapterProvider,
  useAuiState,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react';
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import { useChat } from '@ai-sdk/react';
import { axThreadListAdapter } from './thread-list-adapter';
import { createAxHistoryAdapter } from './history-adapter';
import { AxChatTransport } from './ax-chat-transport';

/** Singleton transport — stateless, so safe to share across renders. */
const axTransport = new AxChatTransport({ api: '/v1/chat/completions' });

/**
 * Thread-specific runtime using AI SDK.
 */
const useChatThreadRuntime = (): AssistantRuntime => {
  const id = useAuiState(({ threadListItem }) => threadListItem.id);
  const chat = useChat({ id, transport: axTransport });
  return useAISDKRuntime(chat);
};

/**
 * Provider that injects AX history adapter into the runtime context.
 */
const AxHistoryProvider = ({ children }: { children?: React.ReactNode }) => {
  const aui = useAui();

  const history = useMemo<ThreadHistoryAdapter>(
    () =>
      createAxHistoryAdapter(
        () => aui.threadListItem().getState().remoteId,
      ),
    [aui],
  );

  const adapters = useMemo(() => ({ history }), [history]);

  return (
    <RuntimeAdapterProvider adapters={adapters}>
      {children}
    </RuntimeAdapterProvider>
  );
};

/**
 * Custom hook that creates a chat runtime with AX-backed thread persistence.
 */
export const useAxChatRuntime = (): AssistantRuntime => {
  return useRemoteThreadListRuntime({
    runtimeHook: () => useChatThreadRuntime(),
    adapter: {
      ...axThreadListAdapter,
      unstable_Provider: AxHistoryProvider,
    },
  });
};
