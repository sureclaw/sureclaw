import { useState, useEffect, useCallback } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useAxChatRuntime } from './lib/useAxChatRuntime';
import type { StatusEvent, Diagnostic } from './lib/ax-chat-transport';
import { signInWithGoogle, signOut, type AuthUser } from './lib/auth';
import { Thread } from './components/thread';
import { ThreadList } from './components/thread-list';
import { Hexagon, Moon, Sun, LogOut } from 'lucide-react';

type AuthState = 'loading' | 'authenticated' | 'login';

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

/** Login page shown when BetterAuth is configured but user has no session. */
function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in-up">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-foreground/[0.04] border border-border/50 mb-4">
            <Hexagon className="h-7 w-7 text-amber" strokeWidth={1.8} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">AX Chat</h1>
          <p className="text-[13px] text-muted-foreground mt-2">
            Sign in to start chatting
          </p>
        </div>

        <div className="card">
          <div className="p-6 space-y-4">
            <button
              onClick={() => signInWithGoogle()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-foreground text-background text-[13px] font-medium hover:bg-foreground/90 transition-colors cursor-pointer"
            >
              Sign in with Google
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Inner component that has access to the runtime context for sending messages. */
const AppContent = ({
  statusMessage,
  diagnostics,
  user,
}: {
  statusMessage: string | null;
  diagnostics: Diagnostic[];
  user: AuthUser | null;
}) => {
  const { isDark, toggle: toggleTheme } = useTheme();

  return (
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
          <div className="px-3 py-3 space-y-1">
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
            {user && (
              <button
                onClick={() => signOut()}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-rose hover:bg-foreground/[0.03] transition-all duration-150"
              >
                <LogOut className="size-4" strokeWidth={1.8} />
                Sign out
              </button>
            )}
          </div>
        </aside>
        {/* Main content */}
        <main className="flex-1 overflow-hidden">
          <div className="noise-bg h-full">
            <Thread statusMessage={statusMessage} diagnostics={diagnostics} />
          </div>
        </main>
    </div>
  );
};

export const App = () => {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);

  // Check authentication on mount
  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      // Try session-based auth (BetterAuth)
      try {
        const res = await fetch('/api/auth/get-session', { credentials: 'include' });

        if (cancelled) return;

        if (res.status === 404) {
          // BetterAuth not configured — allow unauthenticated access (backward compatibility)
          setAuthState('authenticated');
          return;
        }

        if (res.ok) {
          const session = await res.json();
          if (session?.user) {
            setUser(session.user);
            setAuthState('authenticated');
            return;
          }
        }

        // BetterAuth available but no valid session — show login
        setAuthState('login');
      } catch {
        // Network error or BetterAuth not reachable — allow unauthenticated access
        if (cancelled) return;
        setAuthState('authenticated');
      }
    }

    checkAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleStatus = useCallback(
    (event: StatusEvent) => {
      setStatusMessage(event.message || null);
    },
    [],
  );

  const handleRunStart = useCallback(() => {
    setStatusMessage(null);
    setDiagnostics([]);
  }, []);

  const handleDiagnostic = useCallback((d: Diagnostic) => {
    setDiagnostics((prev) => [...prev, d]);
  }, []);

  const runtime = useAxChatRuntime(
    handleStatus,
    handleRunStart,
    user?.id,
    handleDiagnostic,
  );

  // Loading state
  if (authState === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex items-center gap-3 text-muted-foreground">
          <div className="w-5 h-5 border-2 border-amber border-t-transparent rounded-full animate-spin" />
          <span className="text-[13px]">Connecting...</span>
        </div>
      </div>
    );
  }

  // Login page
  if (authState === 'login') {
    return <LoginPage />;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AppContent statusMessage={statusMessage} diagnostics={diagnostics} user={user} />
    </AssistantRuntimeProvider>
  );
};
