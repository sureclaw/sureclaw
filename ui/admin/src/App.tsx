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
  Globe,
  Sparkles,
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
import ConnectorsPage from './components/pages/connectors-page';
import ApprovalsPage from './components/pages/approvals-page';

type Page = 'overview' | 'agents' | 'connectors' | 'approvals' | 'security' | 'logs' | 'settings';
const VALID_PAGES: Page[] = [
  'overview',
  'agents',
  'connectors',
  'approvals',
  'security',
  'logs',
  'settings',
];

/**
 * If the URL has ?page=<name>, return it as the initial page.
 * Returns 'overview' if absent. The param itself is stripped from history
 * inside checkAuth() so reloads land on the default page.
 * Lets Playwright (and anyone else) drive to a page without a sidebar entry.
 */
function readInitialPage(): Page {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('page');
    if (raw && (VALID_PAGES as string[]).includes(raw)) {
      return raw as Page;
    }
  } catch {
    // Ignore — fall through to default.
  }
  return 'overview';
}
type AuthState = 'loading' | 'authenticated' | 'login' | 'access-denied' | 'setup';

const NAV_ITEMS: { id: Page; label: string; icon: typeof Shield }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'agents', label: 'Agents', icon: Users },
  { id: 'approvals', label: 'Approvals', icon: Sparkles },
  { id: 'connectors', label: 'Connectors', icon: Globe },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'settings', label: 'Settings', icon: Settings },
];

/** Access denied screen for authenticated users without admin role. */
function AccessDenied() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in-up">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-foreground/[0.04] border border-border/50 mb-4">
            <Shield className="h-7 w-7 text-rose" strokeWidth={1.8} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Access Denied</h1>
          <p className="text-[13px] text-muted-foreground mt-2">
            You need admin privileges to access this dashboard.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [sessionAuth, setSessionAuth] = useState(false);
  const [activePage, setActivePage] = useState<Page>(readInitialPage);

  // Check authentication on mount
  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      // Check for token in URL query param (e.g. ?token=xxx)
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get('token');
      if (urlToken) {
        setToken(urlToken);
      }
      // Strip `token` (leaks into history) and `page` (pins reloads to the
      // param'd page forever) in one history replacement.
      if (params.has('token') || params.has('page')) {
        params.delete('token');
        params.delete('page');
        const clean = params.toString();
        const newUrl = window.location.pathname + (clean ? `?${clean}` : '') + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      }

      // Check if setup is needed first
      try {
        const setupResult = await apiFetch<SetupStatus>('/setup/status');
        if (cancelled) return;

        if (!setupResult.configured) {
          setAuthState('setup');
          return;
        }

        // If server has auth disabled (and no external auth), auto-authenticate
        if (setupResult.auth_disabled) {
          setAuthState('authenticated');
          return;
        }

        // If external auth (BetterAuth) is configured, skip token check and go straight to session check
        if (setupResult.external_auth) {
          setSessionAuth(true);
        }
      } catch {
        // If setup check fails, continue with auth checks
        if (cancelled) return;
      }

      // If we have a bearer token, use token-based auth
      if (getToken()) {
        if (!cancelled) setAuthState('authenticated');
        return;
      }

      // Try session-based auth (BetterAuth)
      try {
        const res = await fetch('/api/auth/get-session', {
          credentials: 'include',
        });

        if (cancelled) return;

        if (res.ok) {
          const session = await res.json();
          if (session?.user) {
            if (session.user.role === 'admin') {
              setAuthState('authenticated');
            } else {
              setAuthState('access-denied');
            }
            return;
          }
        }

        // Session endpoint exists but no valid session — show session login
        if (res.status !== 404) {
          setSessionAuth(true);
        }
      } catch {
        // BetterAuth not configured or not reachable — fall back to token auth
        if (cancelled) return;
      }

      // No valid auth found — show login
      if (!cancelled) setAuthState('login');
    }

    checkAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for auth-required events (dispatched by apiFetch on 401)
  const handleAuthRequired = useCallback(() => {
    clearToken();
    setAuthState('login');
  }, []);

  useEffect(() => {
    window.addEventListener('ax:auth-required', handleAuthRequired);
    return () => {
      window.removeEventListener('ax:auth-required', handleAuthRequired);
    };
  }, [handleAuthRequired]);

  const handleLogin = useCallback(() => {
    setAuthState('authenticated');
  }, []);

  const handleSetupComplete = useCallback(() => {
    setAuthState('authenticated');
  }, []);

  const handleLogout = useCallback(() => {
    clearToken();
    setAuthState('login');
  }, []);

  // Loading state
  if (authState === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <div className="w-5 h-5 border-2 border-amber border-t-transparent rounded-full animate-spin" />
          <span className="text-[13px]">Connecting to AX...</span>
        </div>
      </div>
    );
  }

  // Setup wizard
  if (authState === 'setup') {
    return <SetupPage onComplete={handleSetupComplete} />;
  }

  // Access denied (authenticated but not admin)
  if (authState === 'access-denied') {
    return <AccessDenied />;
  }

  // Login page
  if (authState === 'login') {
    return <LoginPage onLogin={handleLogin} sessionAuth={sessionAuth} />;
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
            {activePage === 'connectors' && <ConnectorsPage />}
            {activePage === 'approvals' && <ApprovalsPage />}
            {activePage === 'security' && <SecurityPage />}
            {activePage === 'logs' && <LogsPage />}
            {activePage === 'settings' && <SettingsPage />}
          </div>
        </div>
      </main>
    </div>
  );
}
