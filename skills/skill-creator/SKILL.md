---
name: skill-creator
description: Use this skill when the user asks for a capability the agent doesn't yet have — a new integration (Linear, GitHub, Notion, Slack, etc.), a new workflow, a new tool, or "can you check our team's X" where X is a service the agent has no existing connector for. Creates a proper AX skill under .ax/skills/<name>/ with the right frontmatter, credentials, and domain allowlist so the capability becomes permanent after admin approval. Use this skill whenever you'd otherwise be tempted to improvise with one-off scripts, `npm install`, or `execute_script` to reach an external service.
source:
  url: https://github.com/anthropics/skills/tree/main/skills/skill-creator
---

# Skill Creator

A skill for creating new AX skills. Adapted from Anthropic's [skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) (Apache 2.0).

## When to use this skill

Trigger whenever the user asks you to do something that needs a capability you don't have yet. Typical signals:

- "Can you show me our team's open Linear tickets"
- "Pull the latest issues from GitHub for repo X"
- "Summarize my unread Slack mentions"
- "Check what's on my Google Calendar tomorrow"
- Any request that would otherwise make you reach for `execute_script`, `npm install`, or a raw `fetch()` to an external API

Do NOT trigger when the request is already covered by an installed skill or a pre-configured MCP server. Check those first.

## How AX skills work

A skill lives at `.ax/skills/<name>/SKILL.md` in the agent's workspace. After you write it, the git sidecar commits it automatically at end-of-turn — you don't run git yourself. The host reconciler picks up the commit and surfaces a setup card in the admin dashboard listing the skill's required credentials and any domains that need approval. An admin fills those in and approves; the reconciler then registers the skill's MCP servers, adds its domains to the proxy allowlist, and marks the skill active. The skill becomes part of every future turn for this agent.

That last bit is the whole point: **ask once, works forever after**.

**Credentials are provided through the admin dashboard — not through the chat.** The agent does not prompt the user for API keys. The setup card in the dashboard is the one and only path.

## Flow

1. **Capture intent.** Ask the user what the capability should do, when it should trigger, and what output they want. Keep it to 2–3 questions; most of what you need is usually already in the conversation.

2. **Research connectivity, MCP first.** Check whether the service has an official MCP server. Good places to look: the vendor's docs (search "MCP" on their developer site), `github.com/modelcontextprotocol/servers`, and the vendor's GitHub org. An official MCP endpoint is always preferable — it's a single `mcpServers[]` entry plus a credential, no code to write. Note: the URL path varies by vendor (`/mcp`, `/sse`, `/api/v1/mcp`, etc.) — always use the vendor's documented URL, don't guess.

3. **Fallback: OpenAPI spec.** No MCP? Check whether the service publishes an OpenAPI 3.0 spec (the vendor's docs will link to a `/openapi.json` or `/swagger.json`; fetch it and confirm the first line is `{"openapi": "3.0.x", ...}`). An OpenAPI skill declares `openapi[]` with the spec URL + baseUrl + optional auth, and the catalog auto-generates one tool per operation. Scope with `include:` globs if the spec has >20 operations. **See the worked petstore example below** for the exact shape. (v2/Swagger specs are rejected — convert to v3 first.)

4. **Fallback: npx-based tools.** If there's no MCP server AND no OpenAPI spec, look for a CLI tool distributed via npm that you can invoke with `npx <package>`. Declare the tool's API hostnames in `domains[]`. **Never tell the agent to `npm install -g`** — use `npx` (which caches in the workspace) or a project-local `package.json`. The `registry.npmjs.org` host is already on the default allowlist, so `npx` downloads work out of the box.

5. **Last resort: raw HTTPS.** If there's no MCP, no OpenAPI spec, and no decent npx tool, the skill can describe a raw `fetch()` pattern — but this is the worst option. Declare the API hostname in `domains[]` or the proxy will deny it.

6. **Show the proposed frontmatter and wait for confirmation — ALWAYS, no exceptions.** Before writing any SKILL.md, post a compact preview of every high-risk field and stop for the user to confirm or correct. This is mandatory even for vendors you think you know — every field shown below is one the admin later has to fix in the dashboard if we get it wrong, which is slower than a one-turn confirmation now.

   Preview format — bundle everything into one message:

   > Here's the draft for the `linear` skill:
   > - **MCP URL**: `https://mcp.linear.app/mcp`
   > - **Transport**: `http` (Streamable HTTP — matches the `/mcp` path)
   > - **Credential envName**: `LINEAR_API_KEY`
   > - **Auth type**: `api_key`
   > - **Scope**: `user` (each user supplies their own key)
   > - **Extra domains**: none
   >
   > Correct? Or tell me what to change.
   >
   > (If any field is wrong, an admin can edit it in the approval dashboard before enabling the skill — but fixing it now saves a round-trip.)

   Every field below MUST appear in the preview:
   - **MCP URL** — vendor-specific, and vendors often ship BOTH `/sse` (legacy) and `/mcp` (newer Streamable HTTP). Pick your best guess from the vendor's docs and let the user override.
   - **Transport** — `http` for Streamable HTTP (POST-based, the modern default) or `sse` for the legacy SSE transport. AX infers from the URL path (`/sse` → sse, else http) but that inference is only as right as the URL — always show the value explicitly so the user catches a mismatched pick.
   - **Credential envName** — the `SCREAMING_SNAKE_CASE` variable name. Vendors don't always follow the `<SERVICE>_API_KEY` convention (e.g. `GITHUB_TOKEN`, `NOTION_API_KEY`, `FIGMA_ACCESS_TOKEN`). Guess, then confirm.
   - **Auth type** — `api_key` or `oauth`. OAuth needs a full `oauth:` block (authorizationUrl, tokenUrl, clientId, scopes); silent mismatches mean the skill approves as pending and then fails at tool-discovery.
   - **Scope** — `user` (each user supplies their own key) vs `agent` (one shared key across all users). `user` is almost always right for personal-workspace vendors; `agent` fits shared service accounts.
   - **Extra domains** — any additional hostnames the skill will reach beyond the MCP server. If none, say "none" explicitly.

   Fields you DON'T need to preview (safe defaults): `name` (matches directory), `description` (derive from conversation), or the credential value itself (never ask in chat — the admin dashboard is the only path).

   Do NOT write the SKILL.md until the user responds. If the user corrects a field, show the updated preview once more and wait again.

6. **Author via `skill_write` — NOT `write_file`.** `.ax/skills/<name>/SKILL.md` is the only file shape in the workspace with a strict schema attached. The `skill_write` tool takes the frontmatter fields as structured args (`name`, `description`, `credentials`, `mcpServers`, `domains`, `body`) and runs the host's Zod validator before writing. If you get something wrong (missing description, `authType: apiKey`, nested credential object), the tool returns the specific error AND the received value so you can correct it in the next call. No partial-turn silent failures; no "looks fine until the admin sees it."

   `write_file` and `edit_file` REFUSE the `.ax/skills/*/SKILL.md` path — they'll point you at `skill_write`. Other files under `.ax/skills/<name>/` (scripts, reference docs, deletes) still use normal file tools.

   Example call:

   ```
   skill_write({
     name: "linear",
     description: "Query Linear issues. Triggers on: Linear, tickets, sprints, cycles.",
     credentials: [{ envName: "LINEAR_API_KEY", authType: "api_key" }],
     mcpServers: [{ name: "linear", url: "https://mcp.linear.app/mcp", credential: "LINEAR_API_KEY" }],
     body: "## When to use\n...\n## When pending\n...\n## How to use\n..."
   })
   ```

   Keep `body` under ~300 lines. You do not need to run any git commands — the sidecar handles the commit.

7. **Include a "When pending" section in the skill body** (see "Body structure" below). Every skill you draft should tell the next-turn agent what to do when it's still awaiting admin approval — namely, stop and tell the user, don't try the API directly.

8. **Tell the user what happens next.** Something like: "I've drafted the skill. An admin needs to fill in its credentials and approve it in the dashboard. Once approved, just ask me again and it'll work." Don't ask the user for the credential in chat — the dashboard handles that.

## Frontmatter schema

The host validates frontmatter strictly. Unknown fields cause the skill to be rejected. **`mcpServers` is optional** — if the service has no MCP endpoint (CLI tools, raw HTTPS APIs, `npx` packages), leave `mcpServers` off entirely. Don't invent a fake entry to hold a credential; credentials live at the top level. These are the only valid fields:

```yaml
---
name: skill-name                      # required, ≤100 chars, [a-zA-Z0-9_-]
description: |                        # required, ≤2000 chars
  When and why to use this skill. Be specific and a little pushy about
  triggering — Claude tends to under-use skills, so explicit triggers help.
  Mention the concrete phrases/contexts that should activate it.
source:                               # optional — provenance
  url: https://example.com/original
  version: "1.2.0"
credentials:                          # optional — secrets the skill needs
  - envName: SERVICE_API_KEY          # required, /^[A-Z][A-Z0-9_]{1,63}$/
    authType: api_key                 # api_key | oauth (default: api_key)
    scope: user                       # user | agent (default: user)
    # oauth block required only when authType: oauth
    oauth:
      provider: google
      clientId: ...
      authorizationUrl: https://...
      tokenUrl: https://...
      scopes: [openid, email]
mcpServers:                           # optional — remote MCP endpoints
  - name: service                     # ≤100 chars
    url: https://mcp.example.com/mcp  # must be https://; use the vendor's ACTUAL path
    credential: SERVICE_API_KEY       # IMPORTANT: just the envName STRING — must match an entry in credentials[] above. NOT a nested { envName, authType, scope } object.
    transport: http                   # optional — inferred from URL (/sse → sse, else http); override if needed
openapi:                              # optional — OpenAPI/Swagger REST endpoints (parallel to mcpServers)
  - spec: https://api.example.com/openapi.json   # URL to a v3 spec (reject v2/Swagger), or a workspace-relative path
    baseUrl: https://api.example.com/v1          # must be https://; operations get appended to this
    auth:                             # optional — how to inject credentials
      scheme: bearer                  # bearer | basic | api_key_header | api_key_query
      credential: SERVICE_API_KEY     # envName — string ref, same rules as mcpServers[].credential
    include:                          # optional — minimatch globs against bare operationId
      - "findPets*"
      - "getPet*"
    exclude:                          # optional — applied after include
      - "deletePet"
domains:                              # optional — additional allowlist entries
  - api.example.com                   # plain hostname, no scheme, no path
  - "*.my.example.com"                # leading-label wildcard — covers <anything>.my.example.com
---
```

Rules the host enforces:
- `mcpServers[].url` must be `https://`
- `mcpServers[].credential` is a **string** — the envName of an entry in the top-level `credentials:` array. It's a reference, not a definition. Parser rejects `credential: { envName: ..., authType: ... }` with "expected string, received object".
- `mcpServers[].transport` is one of `http` (default) or `sse`
- `openapi[].spec` is a v3 spec URL (or workspace-relative path). v2/Swagger is rejected — convert the spec to v3 first.
- `openapi[].baseUrl` must be `https://` (the URL the operations get appended to).
- `openapi[].auth.scheme` is one of `bearer | basic | api_key_header | api_key_query`. If `auth` is present, BOTH `scheme` and `credential` are required.
- `openapi[].auth.credential` (like MCP) is an envName STRING reference to a top-level `credentials[]` entry.
- `domains[]` entries must be plain hostnames (no `https://`, no `/path`). Leading-label wildcards like `*.foo.com` are allowed for multi-tenant vendors (cover any subdomain of `foo.com`; do NOT cover the bare apex — list that explicitly if needed). Mid-label wildcards, deep wildcards, `*.com`, and bare `*` are rejected as too broad.
- `envName` must be uppercase `SCREAMING_SNAKE_CASE`
- `authType` values are exactly `api_key` or `oauth` (snake_case, NOT `apiKey`/`camelCase`)
- Unknown top-level keys or unknown keys inside a block → rejection

### MCP vs OpenAPI — which integration does this service use?

Two ways to plug a third-party service into the tool catalog. Pick exactly one (or both if the service genuinely exposes both surfaces, which is rare).

- **`mcpServers[]`** — for services that publish a native MCP endpoint (Linear, GitHub, Slack, Notion, Sentry, most modern SaaS with an agent-ready API). The catalog discovers tools via `tools/list` at session start.
- **`openapi[]`** — for services that publish an OpenAPI 3.0 spec but no MCP server (petstore demos, many REST APIs, internal services with Swagger docs). The catalog builds one tool per operation with inputSchema derived from params + requestBody.

**Signals it's OpenAPI, not MCP:**
- The vendor's docs reference "OpenAPI spec" or "Swagger JSON" — and you can `curl` the spec URL and see `openapi: 3.0.x` at the top.
- The vendor publishes a REST API reference but no MCP server.
- You're wrapping an internal service that already has a Swagger UI.

**Do NOT** put the OpenAPI spec URL in `source:` and leave `openapi[]` off. `source:` is *provenance metadata* — where the skill came from, for humans to reference. The catalog-populate loop iterates `openapi[]`, not `source`. A skill with only `source:` set for a REST API will be enabled with **zero** tools in the catalog.

**Do NOT** invent a fake `mcpServers[]` entry pointing at an OpenAPI URL. MCP's `tools/list` will fail against a plain REST endpoint and the skill will be rejected during Test-&-Enable. Use `openapi[]`.

### Scoping wide surfaces with `include:`

An unscoped skill inflates the prompt budget and the LLM's tool-picker load EVERY TURN the skill is active. Scope aggressively:

- **MCP servers with >20 tools**: the host emits a `catalog_wide_mcp_server` diagnostic at catalog-populate time (visible in the chat UI banner) if no `include:` filter is set. Treat >20 as the soft cap — pin to the subset the user actually needs.
- **OpenAPI sources with >30 operations**: same deal, `catalog_wide_openapi_source` diagnostic fires. 30 is the soft cap for OpenAPI because REST specs are chunkier than MCP surfaces on average.

`include:` globs use minimatch syntax, matched against the **bare** tool name (MCP) or **bare** operationId (OpenAPI) — NOT the catalog-prefixed `mcp_<skill>_*` / `api_<skill>_*` form. `exclude:` runs after `include:` for "mostly everything, but not these" scoping.

Examples:

```yaml
# MCP: keep only read-side tools, exclude admin + destructive
mcpServers:
  - name: github
    url: https://mcp.github.com/mcp
    credential: GITHUB_TOKEN
    include: ["get_*", "list_*", "search_*"]
    exclude: ["get_admin_*"]

# OpenAPI: the petstore spec has ~20 ops; scope to read-only
openapi:
  - spec: https://petstore3.swagger.io/api/v3/openapi.json
    baseUrl: https://petstore3.swagger.io/api/v3
    include: ["findPets*", "getPet*", "getInventory", "getOrderById"]
```

**When you're drafting a skill and the vendor's docs list >20 operations/tools**, don't just leave `include:` off hoping the default is fine — it's not. Either ask the user which operations they care about, or propose a sensible read-only default and flag it in the preview step for confirmation.

### Picking the right MCP transport

Two wire protocols are in use in the wild:
- **`http`** (newer, default): POST-based with optional SSE for server→client streams. What the MCP spec calls "Streamable HTTP". Most modern MCP servers (e.g., official GitHub, Slack, filesystem servers).
- **`sse`** (legacy): GET connects for server→client events; separate POST to a session endpoint for client→server messages. **Linear's `mcp.linear.app/sse` uses this.** Anthropic's older MCP servers also.

If you're unsure, `curl -H "Authorization: Bearer <token>" <url>` the endpoint:
- Response starts with `event: endpoint\ndata: /sse/message?sessionId=...` → **`sse`**
- Response is a JSON-RPC envelope or HTTP 405/406 → **`http`**

Getting the transport wrong means tool discovery silently returns zero tools and no catalog entries appear on the next turn. If the skill approves but the tools don't show up in the system prompt, re-check the transport.

## Body structure

Every skill body should have these three sections, in this order:

1. **When to use this skill** — sharp, specific trigger phrases. This is the single most important part of the file after the description, because it's what causes the skill to trigger at the right moment. Be specific, include example user phrases, and be a little pushy about when to use it. Under-triggering is the usual failure mode.

2. **When pending** — what to do if the skill hasn't been approved yet. The agent will read the SKILL.md before knowing whether the skill is active. This section keeps it from improvising. Use this exact template (swap in the right MCP tool names for this skill):

   ```markdown
   ## When pending

   The system prompt's "Available skills" section shows this skill's state. If
   it's `(setup pending: ...)` rather than `enabled`, the required MCP tools
   (e.g. `mcp__<name>__*`) and declared domains are NOT yet available — the
   proxy will deny the hostnames and the tools won't be in your catalog.

   Stop. Do NOT try raw `fetch()`, `execute_script`, or `npx` as a workaround.
   Tell the user: "This skill is still awaiting admin approval. Once an admin
   provides the credentials and approves it in the dashboard, ask me again."
   End the turn.
   ```

3. **How to use** — the actual usage instructions: which tool to call first (MCP tool name, or npx invocation, or raw URL), how to handle common errors (expired token, rate limit, empty result), concrete examples using imperative form. Don't mention authentication details — the host injects credentials from the envName on the agent's behalf; the skill body doesn't need to explain that.

Keep the whole body under 300 lines. If the skill needs more, add companion files (`.ax/skills/<name>/references/*.md`) and reference them from the main SKILL.md with guidance on when to open them.

### Scripts for multi-step recipes (`.ax/skills/<name>/scripts/`)

If a skill's "How to use" section describes a multi-step recipe the agent will perform on almost every invocation — e.g. "fetch issue, enrich with assignee profile, post summary to Slack" — don't let the agent reconstruct the recipe inline every session from prose. Commit it once as a script.

Put reusable scripts at `.ax/skills/<name>/scripts/<verb>.{sh,ts,py}` and reference them from the skill body:

```markdown
## How to use

### Common recipes

- **Summarize a Linear issue** — run `bash .ax/skills/linear/scripts/summarize-issue.sh <issue-id>`.
  The script fetches the issue, its comments, and the assignee's recent activity,
  and prints a Markdown summary.
- **Weekly cycle rollup** — run `bash .ax/skills/linear/scripts/cycle-rollup.sh [team]`.

For anything NOT covered by a script, call the MCP tools directly.
```

Why this matters: inline recipes get rewritten every turn from the prose hint, which is lossy and slow. A committed script is deterministic, testable, and lets the user review the recipe before the agent runs it. Plus the LLM's prompt stays smaller — the skill body only needs a one-line reference, not the whole recipe.

Rules for skill scripts:
- **Put them under `.ax/skills/<name>/scripts/`** — NOT at repo root. Keeps skill-adjacent code colocated with the skill.
- **Shell is usually enough** — one-file scripts that call the MCP tools via `npx` or the API. Reach for TypeScript only if the recipe genuinely needs types (e.g., compiling a response into a structured artifact).
- **Never commit secrets** — scripts read credentials from env vars the host injects. Scripts hardcoding tokens get caught by the credential scanner and rejected at commit time.
- **Script output should be plain text** — the agent reads the script's stdout as a tool result. No ANSI colors, no fancy spinners.

If the skill you're drafting has >2 distinct "how to use" recipes, strongly consider pre-committing them as scripts. The user shouldn't be paying for the LLM to re-derive the same multi-step dance every Monday morning.

## Example: drafting a Linear skill from scratch

User says: "show me open Linear tickets for our product team."

1. **MCP check.** Linear has an official MCP server at `https://mcp.linear.app/sse`. That's the path.
2. **Credential.** Linear uses personal API keys; envName is `LINEAR_API_KEY`.
3. **Domains.** `mcp.linear.app` is the only host the skill needs; no extra `domains[]` required since the MCP server URL is already declared.
4. **Draft** `.ax/skills/linear/SKILL.md`:

```yaml
---
name: linear
description: |
  Query and update Linear issues for the user's team. Use this skill whenever
  the user mentions Linear, tickets, issues, sprints, cycles, or asks about
  team work tracking — even if they don't say "Linear" explicitly. Common
  triggers: "what's on our sprint", "open tickets", "what's <person> working
  on", "create a ticket for X".
credentials:
  - envName: LINEAR_API_KEY
    authType: api_key
    scope: user
mcpServers:
  - name: linear
    url: https://mcp.linear.app/sse
    credential: LINEAR_API_KEY
    transport: sse
---

# Linear

## When to use this skill

Any time the user references Linear, team tickets, sprints, cycles, issue
status, or asks who's working on what. Prefer this skill over web search
or ad-hoc scripts whenever the question is about team work tracking.

## When pending

The system prompt's "Available skills" section shows this skill's state. If
it's `(setup pending: ...)` rather than `enabled`, the `mcp__linear__*` tools
and the `mcp.linear.app` hostname are NOT yet available — the proxy will
deny direct calls and the MCP tools won't be in your catalog.

Stop. Do NOT try raw `fetch()`, `execute_script`, or `npx` as a workaround.
Tell the user: "The Linear skill is still awaiting admin approval. Once an
admin provides `LINEAR_API_KEY` and approves it in the dashboard, ask me
again." End the turn.

## How to use

Call the Linear MCP tools. Common flows:

- List open issues: `mcp__linear__list_issues` with `{state: "open"}`
- Filter by team: add `{team: "product"}`
- Create an issue: `mcp__linear__create_issue` with `{title, description, team}`
```

5. **Write the file.** Use the file-write tool to create `.ax/skills/linear/SKILL.md`. Don't run git — the sidecar commits it.
6. **Tell the user:** "I've drafted a Linear skill. An admin needs to provide `LINEAR_API_KEY` and approve it in the AX dashboard. Once that's done, just ask me again."

## Example: drafting an OpenAPI-based skill (no MCP server, but a spec)

User says: "let me query the public petstore API."

1. **MCP check.** No MCP server — it's a plain REST API.
2. **OpenAPI check.** Petstore publishes a v3 spec at `https://petstore3.swagger.io/api/v3/openapi.json`. Fetch it to confirm: the first line is `{"openapi": "3.0.x", ...}`. That means `openapi[]` is the right block — NOT `mcpServers[]`, NOT just `source:`.
3. **Auth.** The public petstore demo is unauthenticated (read-only endpoints like `findPetsByStatus` work without a key). Omit the `auth:` block entirely.
4. **Scoping.** Petstore's spec has ~20 operations. Scope to read-only with `include:` to keep the catalog tight and avoid teaching the agent destructive endpoints it shouldn't be reaching for.
5. **Draft** `.ax/skills/petstore/SKILL.md`:

```yaml
---
name: petstore
description: |
  Query the public Swagger petstore demo API. Trigger on any mention of
  "petstore", "pets", "pet inventory", or "pet orders" — this is the demo
  API most commonly used for OpenAPI integration testing. Read-only scope.
openapi:
  - spec: https://petstore3.swagger.io/api/v3/openapi.json
    baseUrl: https://petstore3.swagger.io/api/v3
    include:
      - findPets*
      - getPet*
      - getInventory
      - getOrderById
domains:
  - petstore3.swagger.io
---

# Petstore

## When to use this skill

Any time the user mentions the public petstore demo, pet inventory, or
asks to "find available pets" / "look up pet by ID" / "check the petstore
order status." This is the canonical OpenAPI demo — use it when the user
is testing OpenAPI integration, not as a general-purpose pet database.

## When pending

The system prompt's "Available skills" section shows this skill's state.
If it's `(setup pending: ...)` rather than `enabled`, the declared domain
is NOT yet on the proxy allowlist and the catalog tools are NOT populated.

Stop. Tell the user: "The petstore skill is still awaiting admin approval.
Once an admin approves it in the dashboard, ask me again." End the turn.

## How to use

The catalog exposes these tools once enabled (operationId → catalog name):

- `findPetsByStatus` → `api_petstore_find_pets_by_status` with `{status: 'available' | 'pending' | 'sold'}`
- `findPetsByTags` → `api_petstore_find_pets_by_tags` with `{tags: string[]}`
- `getPetById` → `api_petstore_get_pet_by_id` with `{petId: number}`
- `getInventory` → `api_petstore_get_inventory` (no args)
- `getOrderById` → `api_petstore_get_order_by_id` with `{orderId: number}`

Always call `describe_tools(["api_petstore_..."])` first to confirm the
exact arg shape — the adapter derives inputSchema from the spec's
`parameters` + `requestBody`, which is stricter than the prose above.

Handle empty-result arrays gracefully: the API returns `[]` when nothing
matches, not a 404.
```

6. **Write the file** and tell the user: "I've drafted a petstore skill. An admin needs to approve it in the dashboard — no credentials required, it's a public demo. Once approved, ask me again."

**Critical mistake to avoid on OpenAPI skills**: don't put the spec URL in `source:` and leave `openapi[]` off. `source:` is metadata; it does NOT drive catalog population. A skill written that way will approve cleanly and end up enabled with zero tools — and the agent won't be able to tell you what went wrong. The operational block is `openapi[]`.

## Example: drafting a skill when there's no MCP server

User says: "check what PRs I have open on Bitbucket."

1. **MCP check.** No official Bitbucket MCP as of this writing.
2. **npx check.** `bitbucket-api-cli` exists on npm.
3. **Domains.** API calls go to `api.bitbucket.org` — declare it in `domains[]`.
4. **Credential.** Bitbucket uses app passwords; envName `BITBUCKET_APP_PASSWORD`.

```yaml
---
name: bitbucket
description: |
  Query Bitbucket repositories, PRs, and issues. Trigger on any mention
  of Bitbucket, BB, or requests about code hosted outside GitHub/GitLab.
credentials:
  - envName: BITBUCKET_APP_PASSWORD
    authType: api_key
    scope: user
domains:
  - api.bitbucket.org
---

# Bitbucket

## When to use this skill

Any time the user mentions Bitbucket or asks about repos/PRs/issues that
aren't on GitHub or GitLab.

## When pending

The system prompt's "Available skills" section shows this skill's state. If
it's `(setup pending: ...)` rather than `enabled`, `api.bitbucket.org` is
NOT yet on the proxy allowlist and `BITBUCKET_APP_PASSWORD` may not be set.

Stop. Tell the user: "The Bitbucket skill is still awaiting admin approval.
Once an admin provides the app password and approves it in the dashboard,
ask me again." End the turn.

## How to use

Use `bash` with `npx -y bitbucket-api-cli` for queries. The host proxy
automatically routes `api.bitbucket.org` traffic with the credential
injected. Examples:

    npx -y bitbucket-api-cli pr list --state OPEN

Do NOT run `npm install -g` — use `npx -y <pkg>` so packages cache in the
workspace and don't pollute the sandbox.
```

## Not this (common mistakes from training data)

AX's format is strict and differs from the `claude_desktop_config.json` / "generic MCP skill" shape you may have seen elsewhere. Do not pattern-match — always follow the examples above literally.

### WRONG (Claude Desktop config shape — parser rejects)

    # Linear Skill

    Integration with Linear for issue tracking.

    ## Configuration

    ```yaml
    title: Linear
    credentials:
      - LINEAR_API_KEY
    mcp:
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-linear"]
      env:
        LINEAR_API_KEY: "{{LINEAR_API_KEY}}"
    ```

Why this fails:
1. The file starts with `# Linear Skill` (a heading) — frontmatter MUST be on line 1 between two `---` fences. The parser errors with `missing or unterminated YAML frontmatter`.
2. `title:` is not a valid key — AX uses `name:` (and it must match the directory name).
3. `credentials: - LINEAR_API_KEY` is a bare string — the schema wants objects with `envName`, `authType`, `scope`.
4. `mcp: type: stdio, command:, args:` is the Claude Desktop stdio format. AX runs MCP remotely over HTTPS — the sandbox has no process-spawn capability for `npx @modelcontextprotocol/server-*`. Use `mcpServers: [- name, url: https://..., credential]` instead.
5. Unknown top-level keys like `configuration` (if added) would also be rejected by strict Zod parsing.

### WRONG (nested credential OBJECT inside mcpServers — parser rejects)

    mcpServers:
      - name: linear
        url: https://mcp.linear.app/sse
        credential:
          envName: LINEAR_API_KEY
          authType: api_key
          scope: user

Parser error: `mcpServers.0.credential must be a string envName ...`.

`mcpServers[].credential` is a **string reference** pointing at an entry in the top-level `credentials:` array. The credential's definition (envName, authType, scope, oauth block) lives exactly once — in `credentials:` — and every `mcpServers[]` entry that needs to inject that credential cites its envName as a plain string. Common mistake: copying the Claude-Desktop `{env: {...}}` shape into AX.

### WRONG (camelCase authType + missing description — parser rejects both)

    ---
    name: linear
    mcpServers:
      - name: linear
        url: https://mcp.linear.app/mcp
    credentials:
      - envName: LINEAR_API_KEY
        authType: apiKey        # WRONG — must be snake_case: api_key
        scope: user
    ---

Parser errors (both at once):
- `description: Invalid input: expected string, received undefined` — the top-level `description:` YAML field is missing. The Markdown body doesn't count as the description. It's a required frontmatter key, min 1 char, max 2000.
- `credentials.0.authType: Invalid option: expected one of "api_key"|"oauth"` — `apiKey` is camelCase; the enum only accepts `api_key` (snake_case) or `oauth`.

Corrected:

    ---
    name: linear
    description: |
      Query Linear issues. Use when the user mentions Linear, tickets, sprints,
      or cycles — even without saying "Linear" explicitly.
    mcpServers:
      - name: linear
        url: https://mcp.linear.app/mcp
        credential: LINEAR_API_KEY
    credentials:
      - envName: LINEAR_API_KEY
        authType: api_key
        scope: user
    ---

### WRONG (faking an mcpServers entry for a CLI-only tool — parser rejects with URL or transport errors)

    # Service is a CLI tool that makes HTTPS API calls directly; it has NO MCP.
    # Do NOT invent a mcpServers entry to "hold" the credential — leave it off.

    mcpServers:
      - name: salesforce
        url: https://login.salesforce.com          # not actually an MCP server
        credential: SALESFORCE_ACCESS_TOKEN

If there's no MCP server, omit `mcpServers` entirely. Put the credential in `credentials:` and the API hostnames in `domains:`. See the Bitbucket example above for the right pattern.

### RIGHT (AX frontmatter — what the parser accepts)

    ---
    name: linear
    description: |
      When the user asks about Linear tickets, issues, sprints, or cycles.
    credentials:
      - envName: LINEAR_API_KEY
        authType: api_key
        scope: user
    mcpServers:
      - name: linear
        url: https://mcp.linear.app/sse
        credential: LINEAR_API_KEY
        transport: sse              # Linear's /sse endpoint speaks the legacy transport
    ---

    # Linear

    ## When to use this skill
    ...

Every legal field is documented in the schema above. If in doubt, re-read the "Frontmatter schema" section and copy one of the working examples verbatim.

## Don'ts

- **Don't run git.** The sidecar commits at turn end. Running git yourself will fail (you don't have `.git` access) and confuse the reconciler.
- **Don't `npm install -g`.** The sandbox filesystem is read-mostly outside the workspace. Use `npx -y <pkg>` or a project-local `package.json`.
- **Don't skip `domains[]`.** If your skill calls any hostname other than what's declared in `mcpServers[]`, add it to `domains[]` or the proxy will deny the request and the skill will appear broken.
- **Don't hardcode secrets.** Always declare them in `credentials[]` and reference by `envName`. The host injects them at runtime; the agent never sees the raw value.
- **Don't assume the skill is immediately live.** It needs admin approval first. Tell the user.
- **Don't use stdio MCP (`type: stdio`, `command:`, `args:`).** AX only supports remote MCP over HTTPS. If a vendor ships only a stdio MCP binary and has no HTTPS endpoint, fall back to the npx/raw-HTTPS patterns described above — do NOT try to declare stdio in `mcpServers[]`.

## Attribution

This skill is derived from Anthropic's [skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator), licensed under Apache 2.0. See `LICENSE` in this directory. The AX adaptation drops the eval/benchmark infrastructure (AX doesn't ship an eval viewer) and retargets the output format from Claude.ai's skill shape to AX's strict-frontmatter skill shape with MCP server and proxy-allowlist awareness.
