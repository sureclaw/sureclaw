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

export async function signInWithGoogle() {
  const res = await fetch('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
  });
  const data = await res.json();
  if (data?.url) {
    window.location.href = data.url;
  }
}

export async function signOut() {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
  window.location.reload();
}
