import { useEffect, useMemo, useRef } from 'react';
import {
  type AssistantRuntime,
  useRemoteThreadListRuntime,
  useAui,
  RuntimeAdapterProvider,
  useAuiState,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react';
import {
  useAISDKRuntime,
  AssistantChatTransport,
} from '@assistant-ui/react-ai-sdk';
import { useChat, type UIMessage } from '@ai-sdk/react';
import type { ChatTransport } from 'ai';
import { axThreadListAdapter } from './thread-list-adapter';
import { createAxHistoryAdapter } from './history-adapter';

/**
 * Create a dynamic transport proxy that can be updated without recreating the hook.
 */
const useDynamicChatTransport = <UI_MESSAGE extends UIMessage = UIMessage>(
  transport: ChatTransport<UI_MESSAGE>,
): ChatTransport<UI_MESSAGE> => {
  const transportRef = useRef<ChatTransport<UI_MESSAGE>>(transport);
  useEffect(() => {
    transportRef.current = transport;
  });
  return useMemo(
    () =>
      new Proxy(transportRef.current, {
        get(_, prop) {
          const res = transportRef.current[prop as keyof ChatTransport<UI_MESSAGE>];
          return typeof res === 'function' ? res.bind(transportRef.current) : res;
        },
      }),
    [],
  );
};

/**
 * Thread-specific runtime using AI SDK.
 */
const useChatThreadRuntime = (): AssistantRuntime => {
  const transport = useDynamicChatTransport(
    new AssistantChatTransport({ api: '/v1/chat/completions' }),
  );

  const id = useAuiState(({ threadListItem }) => threadListItem.id);
  const chat = useChat({ id, transport });
  const runtime = useAISDKRuntime(chat);

  if (transport instanceof AssistantChatTransport) {
    (transport as any).setRuntime?.(runtime);
  }

  return runtime;
};

/**
 * Provider that injects AX history adapter into the runtime context.
 */
function AxHistoryProvider({ children }: { children?: React.ReactNode }) {
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
}

/**
 * Custom hook that creates a chat runtime with AX-backed thread persistence.
 */
export const useAxChatRuntime = (): AssistantRuntime => {
  return useRemoteThreadListRuntime({
    runtimeHook: function RuntimeHook() {
      return useChatThreadRuntime();
    },
    adapter: {
      ...axThreadListAdapter,
      unstable_Provider: AxHistoryProvider,
    },
  });
};
