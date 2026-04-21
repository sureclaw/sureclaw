# Tool Dispatch Unification — Design

**Status:** design / pre-spec
**Date:** 2026-04-19

## Goal

Unify how AX agents reach external capabilities — MCP servers, OpenAPI endpoints, CLI tools, and prose-documented APIs — behind a single tool catalog and a small, predictable dispatch layer. Eliminate the current `.ax/tools/<skill>/*.js` codegen pipeline and its PTC-style stub imports in `execute_script`. Adopt the Hermes pattern of exposing external tools as first-class agent tools, with a deliberate split for tools whose response shapes are not authoritatively declared.

## Motivation

A week of patching tool-dispatch bugs (see `.claude/journal/host/skills.md` entries from 2026-04-18 through 2026-04-19) revealed a structural mismatch, not a series of unrelated issues. The agent was generating scripts that imported auto-generated JS wrappers around MCP tools, then consuming the responses as if their shapes were predictable. They aren't — MCP tools ship with `inputSchema` but almost never ship `outputSchema`, and different tools on the same server can return wildly different response wrappers (Linear's `list_cycles` returns a bare array, `list_issues` returns `{issues: [...], pageInfo: ...}`, `list_teams` returns `{teams: [...]}`). Each mismatch cost a full LLM turn. Fixes in sequence addressed symptoms — JSDoc format, runtime guards, enum union hints, destructuring braces, wrapping warnings — but the agent kept hitting the next-in-line failure mode.

Hermes (referenced in `docs/plans/hermes-features.md`) deliberately excludes MCP tools from its scripting layer (`SANDBOX_ALLOWED_TOOLS` caps PTC at seven hand-curated built-ins with hand-authored return-shape docstrings) and exposes MCP tools as direct agent tools. Adopting that split here eliminates the class of bug entirely: when every MCP call is its own turn step, the agent sees the raw response before deciding the next call. No shape guessing, no scripted blind spots.

## Design principles

1. **Simplicity over cleverness.** Every subsystem we added this week (shape-learning, runtime guards, enum rendering, destructuring brace conversion) was a legitimate fix for a real symptom. Together they're complexity we don't want to carry. Prefer one mechanism that handles a class of problem over N mechanisms tailored to edge cases.
2. **Cacheable context.** Anthropic's prompt cache gives ~90% discount on stable prefixes. Design the tool catalog and system prompt to be deterministic at session start and unchanged through the session, so every turn after the first pays cache-read pricing.
3. **Minimize response tokens at the dispatcher layer.** Don't rely on the agent to remember to paginate or project. Every response flows through a projection + spill-to-disk boundary that bounds context cost.

## The four API sources, three dispatch paths

| Source | Dispatch path | Tool-name pattern | Notes |
|---|---|---|---|
| **MCP (remote HTTPS/SSE)** | Catalog-registered tool | `mcp_<server>_<tool>` | Existing `mcp-client.ts`; `inputSchema` only |
| **OpenAPI spec** | Catalog-registered tool | `api_<skill>_<operationId>` | New adapter; `inputSchema` + (optional) `outputSchema` |
| **Prose-documented API** | `bash` or optional `http_call` built-in | — | SKILL.md carries the recipe |
| **CLI tools (npx / uvx / binaries)** | `bash` | — | SKILL.md carries the recipe |

The first two are "catalog tools" — they appear in the agent's tool list (via one of the two dispatch modes below). The last two reuse `bash` — no per-endpoint registration, no adapter, no catalog entry. SKILL.md does the work of telling the agent what commands / endpoints exist.

## Dispatch modes

One config field, set in `ax.yaml`:

```yaml
tool_dispatch:
  mode: indirect    # direct | indirect — default: indirect
```

### `direct` mode (for weaker models)

All catalog tools — built-ins plus every MCP/OpenAPI tool — go into the API `tools[]` parameter with full JSON schemas. The agent calls them by name: `mcp_linear_list_issues({...})`. Constrained decoding applies; weak models get structured-output enforcement at the sampling layer.

Bloat is the main risk. Skill frontmatter's `include:` filter caps the per-skill tool count. Skill-creator warns at >20 tools per skill without an `include` filter.

### `indirect` mode (default; for strong models)

Catalog tools appear in the system prompt as one-line summaries only. Two meta-tools — `describe_tools` and `call_tool` — handle the actual interaction:

```
## Available tools

### linear — issue tracking via Linear
- mcp_linear_get_team(query, _select?) — Find a team
- mcp_linear_list_cycles(teamId, type?, _select?) — List cycles
- mcp_linear_list_issues(team?, cycle?, state?, _select?) — List issues
  ...
```

The agent workflow:

1. Read the one-line catalog in the prompt.
2. Call `describe_tools({names: [...]})` to fetch full schemas for tools it's about to use.
3. Call `call_tool({tool: "mcp_linear_list_issues", args: {...}})` to dispatch.

Strong models often skip step 2 when they already know the schema from training.

**Trade-off.** `call_tool` dispatch loses constrained decoding — `args` is typed `object`, so the sampler can't enforce the tool's schema during generation. For Claude Sonnet-class and stronger models the cost is negligible. Weaker models (Haiku, Gemini Flash, small open models) experience ~10-20% more arg-shape errors. `indirect` is the default because it's the right pick for AX's current primary model tier and recovers via clear error responses; teams using weaker models switch to `direct`.

### What stays direct in both modes

Built-in agent tools — `bash`, `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `memory`, `web`, `scheduler`, `save_artifact`, `audit`, `agent` — are always in `tools[]` with full schemas. The mode switch only affects MCP/OpenAPI dispatch. In `indirect` mode, `describe_tools` and `call_tool` join the built-ins.

## The tool catalog

Each catalog entry carries four pieces of data:

```ts
interface CatalogTool {
  name: string;                    // e.g. "mcp_linear_list_issues"
  skill: string;                   // "linear"
  summary: string;                 // one-line description for prompt render
  schema: JSONSchema;              // full inputSchema for describe_tools / tools[]
  dispatch: {
    kind: 'mcp' | 'openapi';
    target: string;                // server URL or operationId reference
    auth?: { credential: string; scheme: 'bearer' | 'basic' | ... };
  };
}
```

Built once per session at agent-spawn time, frozen for the session's lifetime. Stored in the host; shipped to the agent via the stdin payload. No lazy activation, no mid-session mutation.

## Response handling

Every catalog tool supports two things the raw MCP/OpenAPI protocol doesn't: projection and auto-spill.

### Projection via `_select`

Every tool's inputSchema gets an additional optional property: `_select: string` (jq syntax). The dispatcher runs the response through `jq` with the selector before returning:

```json
{
  "tool": "mcp_linear_list_issues",
  "args": {
    "team": "...",
    "cycle": "...",
    "_select": "{issues: .issues | map({id, title, state: .state.name})}"
  }
}
```

The agent gets exactly what it asked for. Missing `_select` means pass-through. A broken `_select` gets an actionable error: "your _select didn't parse: \<jq error\>", cheaper than a retry spiral.

jq was picked over inventing a DSL or accepting field-path lists because (a) it exists, (b) the agent already knows it, (c) it's a single binary to bundle in the sandbox image. The advice against jq for weaker models (they write broken jq) is real but bounded — in `direct` mode the schema shows `_select` as optional, and most weak-model uses will either omit it or copy a known-good selector from SKILL.md examples.

### Auto-spill for large responses

Any response (post-projection) larger than ~20KB gets written to `/tmp/tool-<call-id>.json` by the dispatcher. The agent receives a compact stub:

```json
{
  "_truncated": true,
  "_path": "/tmp/tool-abc123.json",
  "_size_bytes": 154321,
  "preview": "<first ~1KB of pretty-printed response>"
}
```

The agent uses `bash` + `jq` / `grep` / `rg` to query the file. `/tmp` is ephemeral (dies with the sandbox pod) — no cleanup logic. If the agent realizes it wanted a projection instead, it re-runs the tool with `_select`.

Threshold is a config knob (`tool_dispatch.spill_threshold_bytes`, default 20480) — operators can tune for their context-window budget.

## Skill frontmatter

Three changes from current schema, plus a new optional source.

### MCP: `include` filter

Already partially supported (via mcp-registry-sync). Formalize it in the frontmatter schema:

```yaml
mcpServers:
  - name: linear
    url: https://mcp.linear.app/mcp
    credential: LINEAR_API_KEY
    transport: sse
    include:        # glob patterns on tool names
      - list_*
      - get_*
      - create_issue
      - update_issue
```

Optional when the server exposes ≤20 tools; warn at skill-install time if above and no `include:`.

### OpenAPI: new top-level section

```yaml
openapi:
  - spec: https://api.stripe.com/openapi.json   # URL or workspace-relative path
    base_url: https://api.stripe.com
    auth:
      scheme: bearer
      credential: STRIPE_API_KEY
    include:
      - charges/*
      - customers/*
    exclude:
      - "**/reports/**"       # globs match against operationId
```

The adapter:
1. Fetches the spec at install time (cached in the workspace).
2. Parses operations; each becomes a catalog tool named `api_<skill>_<operationId>`.
3. `inputSchema` derived from operation `parameters` + `requestBody`.
4. `outputSchema` captured when present (used today only as a nice-to-have in `describe_tools` output; no runtime validation yet).
5. Dispatch performs the HTTP call through the existing web proxy (credential injection + domain allowlist + audit).

### Prose APIs & CLI tools: no frontmatter adapter

These stay as-is in the frontmatter — `credentials: [...]`, `domains: [...]`. The skill's `SKILL.md` tells the agent what commands or endpoints exist. No per-operation registration in the catalog.

### Skill-bundled scripts

Formalize `.ax/skills/<name>/scripts/` as a first-class directory. Everything mechanically works today (agent can read any workspace file); this just names the convention so `skill-creator` can nudge authors toward bundling a script rather than making the agent write one every session.

## What gets deleted

- `src/host/toolgen/` — the whole codegen pipeline (codegen.ts, generate-and-cache.ts, index.ts)
- `src/host/skills/tool-module-sync.ts` — the module-generation half; keep the state reconciler
- `src/agent/prompt/tool-index-loader.ts` — the prompt render that parses `_index.json`
- `src/agent/prompt/modules/runtime.ts` — the toolModuleIndex rendering branch + response-wrapping hint
- `src/agent/execute-script.ts` — no longer needed; bash + jq + node -e covers ad-hoc work
- `.ax/tools/<skill>/` directory tree in the workspace — stops being generated
- The runtime-guard / enum-union / destructuring-brace / wrapping-hint machinery we built 2026-04-19

## What gets added

- `src/host/tool-catalog.ts` — the catalog type, registration API, prompt-render helpers
- `src/host/adapters/mcp-adapter.ts` — wraps `mcp-client.ts` to produce `CatalogTool`s
- `src/host/adapters/openapi-adapter.ts` — parses OpenAPI specs, produces `CatalogTool`s
- `src/host/ipc-handlers/describe-tools.ts` — returns full schemas for named catalog entries
- `src/host/ipc-handlers/call-tool.ts` — dispatches by catalog lookup; applies `_select`; handles spill
- `src/agent/prompt/modules/tool-catalog.ts` — renders the "Available tools" section from the catalog passed via stdin
- Sandbox image additions: `jq`, `uv` (for `uvx` / `uv run`) if not already present

## Rollout ordering

Not a task breakdown — just the order work should land in.

1. **Catalog type + registration API.** Pure data shape; no behavior change.
2. **Promote MCP tools into the catalog.** Wire `mcp-adapter.ts`; register at skill activation. Keep `.ax/tools/` generation running in parallel for now so the agent isn't broken mid-migration.
3. **Add `describe_tools` + `call_tool` IPC handlers, wired behind `tool_dispatch.mode: indirect`.** Agents in this mode dispatch through the new path.
4. **Add projection (`_select`) and spill-to-disk** in `call_tool`. Smoke-test against Linear; verify the 3-turn "issues in cycle" flow is deterministic.
5. **Add `direct` mode.** MCP tools register directly into `tools[]`. Test with a weak model (Haiku or Flash).
6. **Delete `.ax/tools/` generation + loader + `execute_script`.** Agent prompt switches entirely to catalog-based rendering.
7. **Add OpenAPI adapter.** Test against a small real spec (Stripe subset or a toy one).
8. **Skill-creator updates:** prompts the author to add `include:` filters on wide skills; emits a starter `scripts/` layout when SKILL.md would otherwise have multi-step recipes.

Each step is committable on its own. The migration has a period (steps 2-5) where the old codegen path and the new catalog path coexist.

## Trade-offs and known sharp edges

### `call_tool` on weaker models

`indirect` mode's `call_tool` dispatch loses constrained decoding. For AX's current default model (`gemini-3-flash-preview`, middle-tier) expect a measurable but not pathological rate of arg-shape errors. The `call_tool` handler returns structured errors naming the violated schema field (e.g. `expected team: string, got team: {id: string}`), which recovers most of the ground in the next turn. Operators running weaker models can flip to `direct`.

### Turn count goes up versus scripted chains

A "what issues are in Product's current cycle" query is 3 catalog-tool turn steps (get_team, list_cycles, list_issues), plus one `describe_tools` turn in `indirect` mode, plus the assistant reply. Today's scripted approach aspires to 1 turn step when it works. The new approach gives up the 1-step happy path in exchange for deterministic first-call success, which was the week's real pain point. If measured latency hurts later, shape-learning or a curator-backed active-set are bolt-on optimizations — not requirements.

### Response-shape responsibility moves to the agent

The agent sees the raw MCP/OpenAPI response (or a `_select` projection of it) in each tool-result message. Without `outputSchema` on most MCP tools, the agent's only source of truth about response shape is the response it just received. In practice this works because each response is in-context for the very next decision. It doesn't work for cross-session reuse — every new session rediscovers shapes. That rediscovery is always one call, never the spiral of retries we see today.

### OpenAPI spec fetching at install time

OpenAPI specs can be large (Stripe's is ~5MB). Cache the spec in the workspace at skill install; re-fetch on demand via a `refresh-spec` admin action. The `include:` / `exclude:` filters gate which operations actually become catalog tools, so the 400-operation Stripe case doesn't put 400 entries in the catalog.

### The "no outputSchema" problem isn't solved, just sidestepped

We don't invent response-shape data we don't have. Projection (`_select`) gives the agent a way to ask for less; spill-to-disk gives it a way to inspect without paying context cost. Neither tells the agent the shape upfront. For most workflows that's fine — the agent sees the response before deciding the next step. For "one-shot chained pipeline" workflows (which PTC was optimized for), that's a regression in turn count. Accepted.

## Considered alternative: vector routing + dynamic `tools[]`

An established pattern (used by LangChain, LlamaIndex, various agent products) is to store tool schemas in a vector database, embed the user's query at turn time, retrieve the top-K most semantically similar tools, and inject only those into the LLM's `tools[]`. The agent sees 5-10 tools instead of 200; weak models get near-perfect selection accuracy; constrained decoding applies natively because the retrieved tools are direct entries in `tools[]`.

The pattern is legitimate and tempting at first glance. After thinking through AX's specific deployment, we're not using it as the baseline. Here's the comparison honestly:

| Axis | This design (one-liners + `describe_tools`/`call_tool`) | Vector routing + dynamic `tools[]` |
|---|---|---|
| Per-turn prompt size | ~8K tokens of one-liners for 200 tools; cached stable prefix | ~3K of retrieved schemas; cache breaks when retrieval changes |
| Constrained decoding | Lost for MCP/OpenAPI tools in `indirect` (via `call_tool`) | Native — retrieved tools go into `tools[]` with full schemas |
| Prompt-cache friendliness | Strong — catalog frozen at session start | Weak — per-turn retrieval invalidates the `tools[]` cache segment |
| Chained dependencies | Agent sees all tool names, reasons about `get_team → list_cycles → list_issues` chains upfront | Retrieval must return support tools from one query; `get_team` may not match semantically when the user asks about "issues" |
| "Lost in the middle" | Real risk with 200 tools in the one-liner render | Mitigated by K=5-10 retrieval |
| Infrastructure | ~300 LoC; no new deps (postgres already present) | ~800-1500 LoC + embedding pipeline + vector store (pgvector is plausible but adds surface area) |
| Retrieval failure modes | N/A | Threshold tuning, empty results, noisy MCP descriptions degrading embeddings |
| Weak-model compatibility | `direct` mode fallback with schema-inflated `tools[]`, bounded by `include:` | Native — retrieved subset keeps `tools[]` small |

### The case against vector routing for AX specifically

**Cache arithmetic favors the static approach.** Anthropic's prompt cache gives ~90% discount on stable prefixes. An 8K one-liner block costs full price once, then ~800 effective tokens per subsequent turn. Vector routing with per-turn retrieval sends ~3K of schemas every turn at full price if the retrieval set shifts. Across a multi-turn session, the static approach is almost certainly cheaper in total tokens — unless retrieval is pinned at session start, which gives up the dynamic benefit.

**Retrieval misses on chained operations are real.** "What issues are in this cycle for Product?" matches `list_issues` strongly but the agent actually needs `get_team` (resolve the team name) and `list_cycles` (resolve the cycle). Vector retrieval returns whatever embeds closest to the user query; support tools for chained operations depend on embedding quality and threshold tuning. Every miss means an extra turn for the agent to pull the missing tool. The one-liner approach gives the agent the full map upfront and the LLM does its own in-head retrieval.

**AX's curation model already bounds the catalog.** The "200+ tools in context" problem that motivates vector routing mostly shows up in "public marketplace with thousands of tools" scenarios. AX workspaces have skills approved per-agent; a typical workspace has 3-5 skills and 50-200 tools total. Skills are already the functional taxonomy; `include:` bounds within-skill bloat. Vector retrieval would be reinventing the clustering that skills already express.

**Mitigations for vector-routing's cache and miss problems exist but add complexity.** Pin retrieval at session start (loses dynamic benefit). Retrieve with expansion passes (re-implements skill taxonomy). Use a grow-only `tools[]` that appends new retrievals without invalidating prior cache segments (workable, but adds orchestration). Each mitigation closes a specific gap; together they become substantial engineering effort with ongoing tuning.

### Where vector routing genuinely wins

- Catalogs that grow to 1000+ tools, which AX's curation model avoids.
- "Discovery" workflows where the agent doesn't know which skills are relevant — AX assumes the agent does (skills are listed in the prompt's "Available skills" section).
- Weak models with catalogs too large for `direct` mode even with aggressive `include:` filters.

### Upgrade path if needed later

If the 200-tool indirect catalog becomes painful in practice (measured, not hypothetical), vector routing bolts on cleanly as an optional `find_tools(query)` meta-tool alongside `describe_tools`. Agent uses it when the one-liner list isn't enough to pick. pgvector on the existing postgres instance is the plausible storage. The catalog infrastructure from this design stays unchanged — `find_tools` just becomes an alternative entry point for discovering which tool to `describe_tools` + `call_tool` next.

Ship the simple thing first. Add retrieval only when measured data says the simple thing isn't enough.

## Open questions punted

- **Shape-learning layer** (cache observed response shapes by `(tool, arg-keys-hash)`, surface in the prompt on next session): viable later optimization for repeated-query workflows; not needed for the architecture to work.
- **LLM-curated active set for `direct` mode** (use a stronger model at skill-install time to pick the most useful ~8 tools per skill to keep under a context budget): useful if skill authors aren't disciplined about `include:`, but that's a human-process problem first.
- **Per-delegation mode override** (spawn sub-agents via `agent_delegate` with their own dispatch mode, so a weak-model sub-agent in a strong-model parent session can use `direct`): natural fit with the coding-agents platform vision, deferred until that work starts.
- **`http_call` built-in** (a thin fetch wrapper with proxy + allowlist + credential injection, as a cleaner alternative to `bash curl` for prose APIs): nice to have; not load-bearing since `bash curl` works today.
- **Tool usage telemetry** feeding back into which tools populate the prompt summary (or into future curation decisions): requires an observability pipeline we don't have yet.

## Verification plan

### Unit tests

- Catalog registration from MCP inputSchema produces expected tool entries.
- Catalog registration from a sample OpenAPI spec (vendored fixture) produces expected tool entries.
- `describe_tools` returns schemas for named tools; errors on unknown names.
- `call_tool` dispatches to the right adapter based on tool-name prefix.
- `_select` projection: passes through when absent; applies jq when present; returns actionable error on bad jq.
- Auto-spill: responses under threshold pass through unchanged; responses over threshold get written to disk with stub response.
- Mode resolver: `direct` produces a `tools[]` payload with every catalog entry; `indirect` produces a payload with only built-ins + `describe_tools` + `call_tool`.

### Integration tests

- E2E: Linear skill install → "what issues are in Product's current cycle?" → 3 catalog-tool turn steps (plus describe and assistant reply in `indirect`) → correct answer, zero retries.
- E2E: a small OpenAPI skill (fixture spec) → agent can list + call operations successfully.
- E2E: `direct` mode with a weaker model (Haiku) handles a Linear query correctly.

### Manual verification

- Turn count on the Linear "issues in cycle" query drops from today's 3-10 (with retries) to 4-5 (zero retries) in `indirect` mode.
- Tool catalog in the system prompt measures at ~3K tokens for a single 42-tool skill, cached after turn 1.
- A large Linear response (list_issues without filter) triggers spill-to-disk rather than inflating context.
