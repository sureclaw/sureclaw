// src/providers/auth/better-auth.ts — BetterAuth provider with Google OAuth
import { betterAuth } from 'better-auth';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import type { Config } from '../../types.js';
import type { AuthProvider, AuthResult } from './types.js';
import { dataDir, dataFile } from '../../paths.js';

export async function create(config: Config): Promise<AuthProvider> {
  const authConfig = config.auth?.better_auth;
  if (!authConfig) {
    throw new Error('better-auth provider requires auth.better_auth config');
  }

  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (authConfig.google) {
    socialProviders.google = {
      clientId: authConfig.google.client_id,
      clientSecret: authConfig.google.client_secret,
    };
  }

  // Create database connection — reuse DATABASE_URL for Postgres, otherwise SQLite
  const dbUrl = process.env.POSTGRESQL_URL ?? process.env.DATABASE_URL;
  let database: unknown;

  if (dbUrl?.startsWith('postgres')) {
    const req = createRequire(import.meta.url);
    const { Pool } = req('pg');
    database = new Pool({ connectionString: dbUrl });
  } else {
    mkdirSync(dataDir(), { recursive: true });
    const dbPath = dataFile('auth.db');
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3');
    database = new Database(dbPath);
  }

  const auth = betterAuth({
    database,
    basePath: '/api/auth',
    socialProviders,
    user: {
      additionalFields: {
        role: {
          type: 'string' as const,
          defaultValue: 'user',
          input: false,
        },
      },
    },
    account: {
      accountLinking: { enabled: true },
    },
    databaseHooks: {
      user: {
        create: {
          async after(user, ctx) {
            // First-user admin bootstrap: promote the very first user to admin
            if (!ctx) return;
            try {
              const total = await ctx.context.internalAdapter.countTotalUsers();
              if (total === 1) {
                await ctx.context.internalAdapter.updateUser(user.id, { role: 'admin' });
              }
            } catch {
              // Non-fatal — if counting fails, the user still gets created with 'user' role
            }
          },
        },
      },
    },
  });

  const nodeHandler = toNodeHandler(auth);

  return {
    async init() {
      // BetterAuth handles migrations automatically
    },

    async authenticate(req: IncomingMessage): Promise<AuthResult | null> {
      const cookies = req.headers.cookie;
      if (!cookies) return null;

      try {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
        });

        if (!session?.user) return null;

        // Check domain restriction
        if (authConfig.allowed_domains?.length) {
          const domain = session.user.email?.split('@')[1];
          if (!domain || !authConfig.allowed_domains.includes(domain)) {
            return { authenticated: false };
          }
        }

        return {
          authenticated: true,
          user: {
            id: session.user.id,
            email: session.user.email ?? '',
            name: session.user.name ?? undefined,
            image: session.user.image ?? undefined,
            role: (session.user as Record<string, unknown>).role === 'admin' ? 'admin' : 'user',
          },
        };
      } catch {
        return null;
      }
    },

    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = req.url ?? '';
      if (!url.startsWith('/api/auth/')) return false;

      await nodeHandler(req, res);
      return true;
    },

    async shutdown() {
      // No cleanup needed
    },
  };
}
