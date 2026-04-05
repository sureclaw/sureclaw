import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../../../src/types.js';

describe('auth/better-auth', () => {
  // Set AX_HOME to a temp dir so dataDir()/dataFile() don't collide with real data
  beforeEach(() => {
    process.env.AX_HOME = mkdtempSync(join(tmpdir(), 'ax-better-auth-test-'));
  });

  test('create throws when better_auth config is missing', async () => {
    const config = { admin: { enabled: true, port: 9090 } } as Config;
    const { create } = await import('../../../src/providers/auth/better-auth.js');
    await expect(create(config)).rejects.toThrow('better-auth provider requires auth.better_auth config');
  });

  test('authenticate returns null when no cookie header present', async () => {
    const config = {
      admin: { enabled: true, port: 9090 },
      auth: { better_auth: { google: { client_id: 'test', client_secret: 'test' } } },
    } as unknown as Config;
    const { create } = await import('../../../src/providers/auth/better-auth.js');
    const provider = await create(config);
    const req = { headers: {} } as unknown as IncomingMessage;
    const result = await provider.authenticate(req);
    expect(result).toBeNull();
  });

  test('handleRequest returns false for non-auth routes', async () => {
    const config = {
      admin: { enabled: true, port: 9090 },
      auth: { better_auth: { google: { client_id: 'test', client_secret: 'test' } } },
    } as unknown as Config;
    const { create } = await import('../../../src/providers/auth/better-auth.js');
    const provider = await create(config);
    const req = { url: '/admin/api/status', headers: {} } as unknown as IncomingMessage;
    const res = {} as unknown as ServerResponse;
    const handled = await provider.handleRequest!(req, res);
    expect(handled).toBe(false);
  });

  test('source includes databaseHooks for first-user admin bootstrap', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../../src/providers/auth/better-auth.ts'),
      'utf-8',
    );
    expect(source).toContain('databaseHooks');
    expect(source).toContain('countTotalUsers');
    expect(source).toContain("role: 'admin'");
  });
});

describe('auth/better-auth first-user admin bootstrap', () => {
  test('first user is promoted to admin, second user stays as user', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { betterAuth } = await import('better-auth');
    const { getMigrations } = await import('better-auth/db/migration');

    const db = new DatabaseSync(':memory:');

    const auth = betterAuth({
      baseURL: 'http://localhost:3456',
      database: db,
      basePath: '/api/auth',
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: false },
      secret: 'test-secret-that-is-long-enough-for-validation',
      user: {
        additionalFields: {
          role: {
            type: 'string' as const,
            defaultValue: 'user',
            input: false,
          },
        },
      },
      databaseHooks: {
        user: {
          create: {
            async after(user, ctx) {
              if (!ctx) return;
              try {
                const total = await ctx.context.internalAdapter.countTotalUsers();
                if (total === 1) {
                  await ctx.context.internalAdapter.updateUser(user.id, { role: 'admin' });
                }
              } catch {
                // Non-fatal
              }
            },
          },
        },
      },
    });

    // Run BetterAuth migrations to create tables
    const { runMigrations } = await getMigrations({
      ...auth.options,
      database: db,
    });
    await runMigrations();

    // Create first user — should be promoted to admin
    const first = await auth.api.signUpEmail({
      body: { email: 'first@example.com', password: 'password123456', name: 'First User' },
    });
    expect(first.user).toBeDefined();

    // Query the user's role from the database directly
    const firstRow = db.prepare('SELECT role FROM user WHERE id = ?').get(first.user.id) as { role: string } | undefined;
    expect(firstRow?.role).toBe('admin');

    // Create second user — should remain as 'user'
    const second = await auth.api.signUpEmail({
      body: { email: 'second@example.com', password: 'password123456', name: 'Second User' },
    });
    expect(second.user).toBeDefined();

    const secondRow = db.prepare('SELECT role FROM user WHERE id = ?').get(second.user.id) as { role: string } | undefined;
    expect(secondRow?.role).toBe('user');
  });
});
