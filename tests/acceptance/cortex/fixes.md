# Fix List: Cortex Memory Provider

**Generated from:** acceptance test results (2026-03-06)
**Total issues:** 5 (Critical: 1, Major: 2, Minor: 2)

## Critical

### FIX-1: Migration ordering bug — DbSummaryStore initDefaults() before migrations
**Test:** K8s deployment (crash-loop on startup)
**Environment:** K8s only
**Root cause:** Incorrect — initialization called before table exists
**Location:** `src/providers/memory/cortex/provider.ts:125-135`
**What's wrong:** `summaryStore.initDefaults()` was called before `runMigrations()`, so DbSummaryStore tried to INSERT into `cortex_summaries` before the table existed. Caused crash-loop in PostgreSQL deployments.
**What to fix:** Already fixed by k8s agent — moved migrations before summary store creation.
**Status:** FIXED (in working tree, uncommitted)

## Major

### FIX-2: DeepInfra embedding API key missing from k8s secrets
**Test:** BT-8, BT-9, BT-12, IT-7, IT-8 (all degraded/skipped in k8s)
**Environment:** K8s only
**Root cause:** Integration gap — k8s init doesn't provision embedding API key
**Location:** `src/cli/k8s-init.ts`, `tests/acceptance/fixtures/kind-values.yaml`
**What's wrong:** The `ax k8s init` command provisions the LLM provider API key but not the embedding provider key (DEEPINFRA_API_KEY). The kind-values.yaml references it in `apiCredentials.envVars` but the actual secret doesn't contain a valid value.
**What to fix:** Either: (a) add `--embedding-api-key` flag to `k8s init`, or (b) ensure the acceptance test skill passes DEEPINFRA_API_KEY from `.env.test` into the k8s secret during setup.
**Estimated scope:** 1-2 files
**Status:** FIXED — `k8s init` now consolidates LLM and embeddings API keys into the single `ax-api-credentials` secret via `apiCredentials.envVars`, matching the Helm chart's native pattern. The `--embeddings-provider` and `--embeddings-api-key` flags provision the key alongside the LLM key.

### FIX-3: Taint not exposed in agent memory tool schema
**Test:** BT-6 (partial in k8s)
**Environment:** Both
**Root cause:** Incomplete — tool schema missing taint parameter
**Location:** `src/agent/tool-catalog.ts` or memory tool definition
**What's wrong:** The `memory_write` tool doesn't expose a `taint` parameter, so users can't set taint tags via the tool. Taint is only system-managed (set during memorize from conversation context).
**What to fix:** Evaluate whether taint should be user-settable via tools. If yes, add optional `taint` parameter to memory_write tool schema. If no (security decision), document this as intentional and update the test expectation.
**Estimated scope:** 1 file
**Status:** RESOLVED (intentional) — Taint is system-managed for security. The host-side `memory_write` IPC handler does not inject taint from tool params; taint is only set during `memorize()` from conversation context. Allowing agents to set their own trust tags would undermine the taint-tracking security model. The `write()` method on MemoryProvider accepts taint for internal/host-side use only.

## Minor

### FIX-4: query() does not reinforce accessed items (plan deviation DEV-1/DEV-4)
**Test:** ST-16-old, noted in both local and k8s results
**Environment:** Both
**Root cause:** Incomplete — plan feature not implemented
**Location:** `src/providers/memory/cortex/provider.ts` — `query()` and `read()` functions
**What's wrong:** The plan specifies that reading/querying items should increment their reinforcement count (boosting salience for frequently accessed items). Neither `query()` nor `read()` calls `store.reinforce()`.
**What to fix:** Add `store.reinforce(id)` calls in query/read paths after returning results. Consider making this async/non-blocking to avoid slowing reads. Alternatively, document as intentional deviation if read-path reinforcement was deliberately omitted.
**Estimated scope:** 1 file
**Status:** FIXED — Added fire-and-forget `store.reinforce()` calls in both read() and query() (embedding + keyword paths). Tests added in provider.test.ts verifying salience boost from repeated access.

### FIX-5: Explicit write() uses reinforcementCount=10 (plan deviation DEV-2)
**Test:** IT-3 (noted in both environments)
**Environment:** Both
**Root cause:** Incorrect — plan says initial reinforcement should be 1
**Location:** `src/providers/memory/cortex/provider.ts` — `write()` function
**What's wrong:** Explicit `write()` calls set `reinforcementCount: 10`, giving them 10x the salience weight of memorize-extracted items. The plan specifies initial count of 1.
**What to fix:** Evaluate whether this is intentional (explicit writes are "more important") or a bug. If intentional, document it. If not, change to `reinforcementCount: 1`.
**Estimated scope:** 1 file
**Status:** FIXED — Changed to `reinforcementCount: 1` per plan spec. With read-path reinforcement now implemented (FIX-4), frequently accessed items naturally gain salience over time without an artificial initial boost.

## K8s-Specific Issues (2026-03-06 run #2)

### FIX-6: Helm chart does not inject API credentials into host deployment
**Test:** IT-7, BT-8 (infrastructure blocker for multiple tests)
**Environment:** K8s only
**Root cause:** Incomplete
**Location:** `charts/ax/templates/host-deployment.yaml`, `charts/ax/templates/_helpers.tpl`
**What's wrong:** The Helm chart only mounts the `ax-api-credentials` secret as environment variables into the agent-runtime deployment. The host deployment does not receive OPENROUTER_API_KEY or DEEPINFRA_API_KEY. The host process needs these for LLM extraction (memory write path) and embedding API calls (memory read path). Currently requires manual `kubectl patch deployment` to work around.
**What to fix:** Add the same `envFrom` / `env` secret references from the agent-runtime deployment template to the host deployment template. Both deployments need access to the API credentials secret.
**Estimated scope:** 1-2 files (host-deployment.yaml, possibly _helpers.tpl)

### FIX-7: sqlite-vec extension missing from container image
**Test:** BT-8, IT-7, IT-8 (blocks all embedding/vector search tests)
**Environment:** K8s only
**Root cause:** Missing
**Location:** `container/Dockerfile`
**What's wrong:** The Docker image does not include the sqlite-vec native extension. The `EmbeddingStore` checks for sqlite-vec availability at startup and sets `available = false` when it can't load the extension. This disables all vector search functionality: write-time embedding generation, embedding backfill, and semantic recall.
**What to fix:** Either (a) install sqlite-vec in the Dockerfile (npm package `sqlite-vec` or compile from source), or (b) implement a PostgreSQL-based vector store using pgvector for k8s deployments. Option (a) is simpler; option (b) is more architecturally sound for k8s.
**Estimated scope:** 1 file for option (a), 3-5 files for option (b)

### FIX-8: Keyword search treats OR-separated terms as literal substring
**Test:** IT-7
**Environment:** Both (affects local too, but masked by sqlite-vec availability locally)
**Root cause:** Incorrect
**Location:** `src/providers/memory/cortex/items-store.ts` (~line 157, `searchContent()` method)
**What's wrong:** `searchContent()` builds a SQL query `WHERE content LIKE '%query%'` where `query` is the raw output of `extractQueryTerms()` (e.g., `"set OR deployment OR pipeline"`). This performs a literal substring match on the entire string including "OR", rather than splitting into separate terms and matching any of them. Keyword-based recall is effectively broken for multi-term queries.
**What to fix:** Parse the OR-separated terms from `extractQueryTerms()` into individual terms, then build multiple `LIKE` conditions joined with SQL `OR`: `WHERE content LIKE '%set%' OR content LIKE '%deployment%' OR content LIKE '%pipeline%'`. Use parameterized queries to prevent SQL injection.
**Estimated scope:** 1 file

### FIX-9: PostgreSQL auth mismatch with Bitnami subchart defaults
**Test:** Infrastructure setup (blocked all tests until manually fixed)
**Environment:** K8s only
**Root cause:** Integration gap
**Location:** `charts/ax/values.yaml`, `charts/ax/templates/_helpers.tpl`
**What's wrong:** When `postgresql.internal.auth.password` is not explicitly set, the Bitnami PostgreSQL subchart generates only a `postgres-password` key (superuser) in the secret. The chart's `_helpers.tpl` constructs a DATABASE_URL using the custom `ax` user, but that user doesn't have a matching password in the generated secret, causing authentication failure.
**What to fix:** Either (a) explicitly set `postgresql.auth.username` and `postgresql.auth.password` in values.yaml defaults so the Bitnami chart creates the custom user, or (b) update `_helpers.tpl` to use the `postgres` superuser when a custom user password isn't available, or (c) add an init container/job that creates the `ax` database and user.
**Estimated scope:** 1-2 files

## Suggested Fix Order

1. **FIX-6** — API credentials in host deployment. Blocks memory extraction and embedding in k8s. Quick chart fix, high impact.
2. **FIX-9** — PostgreSQL auth mismatch. Blocks fresh k8s deployments entirely. Small values.yaml change.
3. **FIX-8** — Keyword search LIKE bug. Affects recall quality in both environments. Single file fix.
4. **FIX-7** — sqlite-vec in container. Enables full vector search in k8s. Requires decision on approach (native extension vs pgvector).
5. **FIX-1** — Already fixed, just needs commit. Blocks k8s deployments.
6. **FIX-4** — Already fixed, needs commit.
7. **FIX-5** — Already fixed, needs commit.
