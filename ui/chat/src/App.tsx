import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useAxChatRuntime } from './lib/useAxChatRuntime';
import { Thread } from './components/thread';
import { ThreadList } from './components/thread-list';

export const App = () => {
  const runtime = useAxChatRuntime();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-screen bg-background">
        {/* Sidebar */}
        <div className="flex w-64 flex-col border-r border-border bg-background">
          <div className="flex items-center gap-2 px-4 py-4 border-b border-border">
            <span className="text-lg font-semibold text-foreground">ax</span>
            <span className="text-sm text-muted-foreground">chat</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ThreadList />
          </div>
        </div>
        {/* Main content */}
        <div className="flex-1">
          <Thread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
};
