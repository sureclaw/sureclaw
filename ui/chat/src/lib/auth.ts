// ui/chat/src/lib/auth.ts

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  image?: string;
  role: string;
}

export interface AuthSession {
  user: AuthUser;
}

export async function getSession(): Promise<AuthSession | null> {
  try {
    const res = await fetch('/api/auth/get-session', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.user ? data : null;
  } catch {
    return null;
  }
}

export function signInWithGoogle() {
  window.location.href = '/api/auth/sign-in/social?provider=google&callbackURL=/';
}

export async function signOut() {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
  window.location.reload();
}
