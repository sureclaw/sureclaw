import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useAxChatRuntime } from './lib/useAxChatRuntime';
import { Thread } from './components/thread';
import { ThreadList } from './components/thread-list';
import { Hexagon } from 'lucide-react';

export function App() {
  const runtime = useAxChatRuntime();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-screen bg-background">
        {/* Sidebar */}
        <aside className="flex h-screen w-[220px] flex-col border-r border-border/50 bg-sidebar">
          {/* Logo */}
          <div className="flex h-16 items-center gap-3 px-6">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber/10">
              <Hexagon className="h-4 w-4 text-amber" strokeWidth={2.5} />
            </div>
            <div>
              <span className="text-[15px] font-semibold tracking-tight text-foreground">
                ax
              </span>
              <span className="ml-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                chat
              </span>
            </div>
          </div>

          <div className="h-px bg-border/30" />

          <div className="flex-1 overflow-y-auto px-3 py-2">
            <ThreadList />
          </div>
        </aside>
        {/* Main content */}
        <main className="flex-1 overflow-hidden">
          <div className="noise-bg h-full">
            <Thread />
          </div>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}
