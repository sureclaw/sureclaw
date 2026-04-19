# Provider Lessons: Auth

### BetterAuth needs baseURL set explicitly; AX exposes it via `auth.better_auth.base_url`
**Date:** 2026-04-17
**Context:** On a kind deployment the AX host logged `[Better Auth]: Base URL could not be determined.` BetterAuth autoresolves from `BETTER_AUTH_URL` env or the incoming request, but Kubernetes ingress/service paths often break request inference.
**Lesson:** AX's better-auth provider now reads `config.auth.better_auth.base_url` and falls back to `process.env.BETTER_AUTH_URL`. Set the config field to the externally-reachable URL (what the browser actually hits — e.g. `http://localhost:8080` for port-forward, `https://ax.example.com` for ingress). Whatever value is used must also appear in the Google Cloud OAuth client's authorized redirect URIs as `<base_url>/api/auth/callback/google`.
**Tags:** better-auth, oauth, config, kubernetes, base-url

### BetterAuth database option requires raw DB instances, not URL strings
**Date:** 2026-04-05
**Context:** Implementing the BetterAuth provider. The task plan specified `database: { url: dbUrl, type: dbType }` but BetterAuth v1.5.6 does not accept that shape.
**Lesson:** BetterAuth's `database` option accepts raw database instances (better-sqlite3 `Database`, pg `Pool`, Kysely `Dialect`, or `{db: Kysely, type}`) but NOT a `{url, type}` shorthand. Create the database connection explicitly and pass the instance. Check `node_modules/@better-auth/core/dist/types/init-options.d.mts` for the actual union type.
**Tags:** better-auth, database, api-mismatch, auth

### Use fromNodeHeaders() from better-auth/node for header conversion
**Date:** 2026-04-05
**Context:** Converting Node.js IncomingMessage headers to Web Headers for BetterAuth's getSession() API
**Lesson:** `better-auth/node` exports `fromNodeHeaders()` alongside `toNodeHandler()`. Use it instead of manually constructing `new Headers(...)` from `req.headers` -- it correctly handles array-valued headers with `.append()`.
**Tags:** better-auth, node, headers, auth

### BetterAuth databaseHooks for lifecycle events
**Date:** 2026-04-05
**Context:** Implementing first-user admin bootstrap — needed to hook into user creation
**Lesson:** BetterAuth supports `databaseHooks` in the betterAuth() config with `user.create.before` and `user.create.after` hooks. The `before` hook receives `(user, ctx)` and can return `{ data: modifiedUser }` to alter the user before creation, or `false` to prevent creation. The `after` hook receives `(user, ctx)` and can perform side effects. `ctx.context.internalAdapter` provides `countTotalUsers()`, `updateUser()`, `findUserById()`, etc. The `ctx` parameter can be null, so always guard with `if (!ctx) return`. For testing, use `node:sqlite` DatabaseSync with `:memory:`, `getMigrations` from `better-auth/db/migration`, and `auth.api.signUpEmail` to create test users.
**Tags:** better-auth, databaseHooks, lifecycle, auth, testing
