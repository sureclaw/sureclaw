import { Shield, Hexagon } from 'lucide-react';

interface LoginPageProps {
  onLogin: () => void;
  sessionAuth?: boolean;
}

export default function LoginPage({ onLogin: _onLogin, sessionAuth }: LoginPageProps) {
  const handleGoogleLogin = async () => {
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ provider: 'google', callbackURL: '/admin' }),
    });
    const data = await res.json();
    if (data?.url) {
      window.location.href = data.url;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in-up">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-foreground/[0.04] border border-border/50 mb-4">
            <Hexagon className="h-7 w-7 text-amber" strokeWidth={1.8} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">AX Admin</h1>
          <p className="text-[13px] text-muted-foreground mt-2">
            Sign in to access the admin dashboard
          </p>
        </div>

        {sessionAuth ? (
          /* Session-based auth: show Google sign-in button */
          <div className="card">
            <div className="p-6 space-y-4">
              <button
                onClick={handleGoogleLogin}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-foreground text-background text-[13px] font-medium hover:bg-foreground/90 transition-colors cursor-pointer"
              >
                Sign in with Google
              </button>
            </div>
          </div>
        ) : (
          /* Token-based auth: show instructions */
          <>
            <div className="card">
              <div className="p-6 space-y-4">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-rose/5 border border-rose/15">
                  <Shield size={16} className="text-rose mt-0.5 shrink-0" />
                  <p className="text-[13px] text-rose">
                    No admin token provided. Use the URL from your server console output to access the dashboard.
                  </p>
                </div>
              </div>
            </div>

            <p className="text-center text-[11px] text-muted-foreground/50 mt-4">
              The admin URL with token is printed when the server starts.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
