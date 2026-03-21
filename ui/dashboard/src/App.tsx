import { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  Activity,
  Users,
  FileText,
  Settings,
  LogOut,
  Hexagon,
  ChevronRight,
} from 'lucide-react';
import { getToken, setToken, clearToken, apiFetch } from './lib/api';
import type { SetupStatus } from './lib/types';
import LoginPage from './components/pages/login-page';
import SetupPage from './components/pages/setup-page';
import OverviewPage from './components/pages/overview-page';
import AgentsPage from './components/pages/agents-page';
import SecurityPage from './components/pages/security-page';
import LogsPage from './components/pages/logs-page';
import SettingsPage from './components/pages/settings-page';

type Page = 'overview' | 'agents' | 'security' | 'logs' | 'settings';

const NAV_ITEMS: { id: Page; label: string; icon: typeof Shield }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'agents', label: 'Agents', icon: Users },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [authenticated, setAuthenticated] = useState(() => {
    // Check for token in URL query param (e.g. ?token=xxx)
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      setToken(urlToken);
      // Strip token from URL to avoid leaking it in browser history
      params.delete('token');
      const clean = params.toString();
      const newUrl = window.location.pathname + (clean ? `?${clean}` : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
      return true;
    }
    return !!getToken();
  });
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [activePage, setActivePage] = useState<Page>('overview');
  const [checkingSetup, setCheckingSetup] = useState(true);

  // Check if initial setup is needed
  useEffect(() => {
    let cancelled = false;

    async function checkSetup() {
      try {
        const result = await apiFetch<SetupStatus>('/setup/status');
        if (!cancelled) {
          setNeedsSetup(!result.configured);
          setCheckingSetup(false);
        }
      } catch {
        // If we can't reach the endpoint, assume configured
        if (!cancelled) {
          setNeedsSetup(false);
          setCheckingSetup(false);
        }
      }
    }

    checkSetup();
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  // Listen for auth-required events (dispatched by apiFetch on 401)
  const handleAuthRequired = useCallback(() => {
    clearToken();
    setAuthenticated(false);
  }, []);

  useEffect(() => {
    window.addEventListener('ax:auth-required', handleAuthRequired);
    return () => {
      window.removeEventListener('ax:auth-required', handleAuthRequired);
    };
  }, [handleAuthRequired]);

  const handleLogin = useCallback(() => {
    setAuthenticated(true);
  }, []);

  const handleSetupComplete = useCallback(() => {
    setNeedsSetup(false);
    setAuthenticated(true);
  }, []);

  const handleLogout = useCallback(() => {
    clearToken();
    setAuthenticated(false);
  }, []);

  // Show setup wizard if not configured
  if (checkingSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <div className="w-5 h-5 border-2 border-amber border-t-transparent rounded-full animate-spin" />
          <span className="text-[13px]">Connecting to AX...</span>
        </div>
      </div>
    );
  }

  if (needsSetup) {
    return <SetupPage onComplete={handleSetupComplete} />;
  }

  // Show login if not authenticated
  if (!authenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // Main dashboard layout
  return (
    <div className="min-h-screen flex">
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
              admin
            </span>
          </div>
        </div>

        <div className="h-px bg-border/30" />

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4">
          <ul className="space-y-1">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  onClick={() => setActivePage(id)}
                  className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-all duration-150
                    ${
                      activePage === id
                        ? 'bg-foreground/[0.06] text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground/80'
                    }`}
                >
                  <Icon
                    size={16}
                    strokeWidth={1.8}
                    className={
                      activePage === id
                        ? 'text-amber'
                        : 'text-muted-foreground group-hover:text-foreground/60'
                    }
                  />
                  {label}
                  {activePage === id && (
                    <ChevronRight className="ml-auto h-3 w-3 text-muted-foreground/50" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="h-px bg-border/30" />

        {/* Bottom section */}
        <div className="px-3 py-4">
          <button
            onClick={handleLogout}
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium text-muted-foreground hover:text-rose hover:bg-foreground/[0.03] transition-all duration-150"
          >
            <LogOut size={16} strokeWidth={1.8} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="noise-bg min-h-full">
          <div className="mx-auto max-w-[1400px] px-8 py-6">
            {activePage === 'overview' && <OverviewPage />}
            {activePage === 'agents' && <AgentsPage />}
            {activePage === 'security' && <SecurityPage />}
            {activePage === 'logs' && <LogsPage />}
            {activePage === 'settings' && <SettingsPage />}
          </div>
        </div>
      </main>
    </div>
  );
}
