import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../../types.js';
import type { AuthProvider, AuthResult } from './types.js';

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization?.trim() ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  return (req.headers['x-ax-token'] as string)?.trim() || undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function create(config: Config): Promise<AuthProvider> {
  const token = config.admin?.token;

  return {
    async authenticate(req: IncomingMessage): Promise<AuthResult | null> {
      const provided = extractToken(req);
      if (!provided) return null;

      if (!token) return { authenticated: false };
      if (!safeEqual(provided, token)) return { authenticated: false };

      return {
        authenticated: true,
        user: { id: 'admin-token', email: '', role: 'admin' },
      };
    },
  };
}
