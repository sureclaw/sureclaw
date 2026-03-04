import { useState, type FormEvent } from 'react';
import { Shield, Key, Hexagon } from 'lucide-react';
import { apiFetch, setToken } from '../../lib/api';
import type { ServerStatus } from '../../lib/types';

interface LoginPageProps {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [token, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token.trim()) {
      setError('Token is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Temporarily set the token so apiFetch can use it
      setToken(token.trim());
      await apiFetch<ServerStatus>('/status');
      onLogin();
    } catch (err) {
      // Clear the invalid token
      localStorage.removeItem('ax-admin-token');
      setError(
        err instanceof Error
          ? err.message.includes('401')
            ? 'Invalid token. Check your ax.yaml admin configuration.'
            : err.message
          : 'Authentication failed'
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in-up">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-foreground/[0.04] border border-border/50 mb-4">
            <Hexagon className="h-7 w-7 text-amber" strokeWidth={1.8} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">AX Admin</h1>
          <p className="text-[13px] text-muted-foreground mt-1">
            Enter your admin token to continue
          </p>
        </div>

        {/* Login card */}
        <div className="card">
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label
                htmlFor="token"
                className="block text-[13px] font-medium text-foreground/80 mb-1.5"
              >
                <div className="flex items-center gap-2">
                  <Key size={14} />
                  Admin Token
                </div>
              </label>
              <input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ax-admin-..."
                className="input w-full"
                autoFocus
                disabled={loading}
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-rose/5 border border-rose/15">
                <Shield size={16} className="text-rose mt-0.5 shrink-0" />
                <p className="text-[13px] text-rose">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  Authenticating...
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-[11px] text-muted-foreground/50 mt-4">
          Token is set in your ax.yaml configuration file.
        </p>
      </div>
    </div>
  );
}
