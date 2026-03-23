import { useState, useCallback } from 'react';
import { AssistantRuntimeProvider, useAui } from '@assistant-ui/react';
import { useAxChatRuntime } from './lib/useAxChatRuntime';
import type { CredentialRequiredEvent } from './lib/ax-chat-transport';
import { Thread } from './components/thread';
import { ThreadList } from './components/thread-list';
import { CredentialModal } from './components/credential-modal';
import { Hexagon, Moon, Sun } from 'lucide-react';

const useTheme = () => {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.classList.contains('dark'),
  );

  const toggle = useCallback(() => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('ax-chat-theme', next ? 'dark' : 'light');
  }, [isDark]);

  return { isDark, toggle };
};

/** Inner component that has access to the runtime context for sending messages. */
const AppContent = ({
  credentialRequest,
  onCredentialProvided,
  onCredentialCancelled,
}: {
  credentialRequest: CredentialRequiredEvent | null;
  onCredentialProvided: () => void;
  onCredentialCancelled: () => void;
}) => {
  const aui = useAui();
  const { isDark, toggle: toggleTheme } = useTheme();

  const handleSubmit = useCallback(
    () => {
      onCredentialProvided();
      // Auto-send a follow-up message so the agent retries
      try {
        aui.thread().append({
          role: 'user',
          content: [{ type: 'text', text: 'Credentials provided, please continue.' }],
        });
      } catch { /* thread may not be ready */ }
    },
    [aui, onCredentialProvided],
  );

  return (
    <>
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

          <div className="h-px bg-border/30" />
          <div className="px-3 py-3">
            <button
              onClick={toggleTheme}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground transition-all duration-150"
            >
              {isDark
                ? <Sun className="size-4 text-amber" strokeWidth={1.8} />
                : <Moon className="size-4 text-violet" strokeWidth={1.8} />
              }
              {isDark ? 'Light mode' : 'Dark mode'}
            </button>
          </div>
        </aside>
        {/* Main content */}
        <main className="flex-1 overflow-hidden">
          <div className="noise-bg h-full">
            <Thread />
          </div>
        </main>
      </div>

      {/* Credential modal */}
      {credentialRequest && (
        <CredentialModal
          request={credentialRequest}
          onSubmit={handleSubmit}
          onCancel={onCredentialCancelled}
        />
      )}
    </>
  );
};

export const App = () => {
  const [credentialRequest, setCredentialRequest] =
    useState<CredentialRequiredEvent | null>(null);

  const handleCredentialRequired = useCallback(
    (event: CredentialRequiredEvent) => {
      setCredentialRequest(event);
    },
    [],
  );

  const runtime = useAxChatRuntime(handleCredentialRequired);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AppContent
        credentialRequest={credentialRequest}
        onCredentialProvided={() => setCredentialRequest(null)}
        onCredentialCancelled={() => setCredentialRequest(null)}
      />
    </AssistantRuntimeProvider>
  );
};
