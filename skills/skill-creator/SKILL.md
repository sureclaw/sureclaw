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

3. **Fallback: npx-based tools.** If there's no MCP server, look for a CLI tool distributed via npm that you can invoke with `npx <package>`. Declare the tool's API hostnames in `domains[]`. **Never tell the agent to `npm install -g`** — use `npx` (which caches in the workspace) or a project-local `package.json`. The `registry.npmjs.org` host is already on the default allowlist, so `npx` downloads work out of the box.

4. **Last resort: raw HTTPS.** If there's no MCP and no decent npx tool, the skill can describe a raw `fetch()` pattern — but this is the worst option. Declare the API hostname in `domains[]` or the proxy will deny it.

5. **Show the proposed frontmatter and wait for confirmation — ALWAYS, no exceptions.** Before writing any SKILL.md, post a compact preview of your draft values and stop for the user to confirm or correct. This is mandatory even when you think you know the vendor — silent mis-guesses on URL or authType are the single most common reason a skill approves as pending and then fails at tool-discovery time with an unhelpful error. One extra turn to confirm beats an admin-side debugging cycle.

   Preview format — bundle everything into one message:

   > Here's the draft for the `linear` skill:
   > - **MCP URL**: `https://mcp.linear.app/sse`
   > - **Auth**: API key (`LINEAR_API_KEY`, user-scoped)
   > - **Extra domains**: none
   >
   > Correct? Or tell me what to change.

   Three fields are high-risk and MUST appear in the preview:
   - **MCP URL** — vendor-specific. Vendors often ship both `/sse` (legacy SSE) and `/mcp` (newer Streamable HTTP) endpoints; you may not know which the user wants. Show your pick, let them override.
   - **`authType`** — OAuth vs `api_key` silently breaks approval if wrong (OAuth needs an `oauth:` block). Guess from the vendor's docs, then confirm.
   - **Extra `domains[]`** — list any additional hostnames the skill will reach beyond the MCP server. If none, say "none" explicitly.

   Fields you DON'T need to preview (safe defaults): `name` (matches directory), `description` (derive from conversation), `envName` (follow vendor's `<SERVICE>_API_KEY` convention), `scope` (`user` is almost always right), `transport` (AX infers from URL path — `/sse` → sse, else http), or the credential value itself (never ask in chat — the admin dashboard is the only path).

   Do NOT write the SKILL.md until the user responds. If the user corrects a field, show the updated preview once more and wait again. Yes, even for "obvious" vendors like Linear — your confidence has been wrong before.

6. **Draft the SKILL.md.** Write it to `.ax/skills/<new-name>/SKILL.md` using the frontmatter schema below. Keep the body under ~300 lines. You do not need to run any git commands — the sidecar handles the commit.

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
domains:                              # optional — additional allowlist entries
  - api.example.com                   # plain hostname, no scheme, no path
  - "*.my.example.com"                # leading-label wildcard — covers <anything>.my.example.com
---
```

Rules the host enforces:
- `mcpServers[].url` must be `https://`
- `mcpServers[].credential` is a **string** — the envName of an entry in the top-level `credentials:` array. It's a reference, not a definition. Parser rejects `credential: { envName: ..., authType: ... }` with "expected string, received object".
- `mcpServers[].transport` is one of `http` (default) or `sse`
- `domains[]` entries must be plain hostnames (no `https://`, no `/path`). Leading-label wildcards like `*.foo.com` are allowed for multi-tenant vendors (cover any subdomain of `foo.com`; do NOT cover the bare apex — list that explicitly if needed). Mid-label wildcards, deep wildcards, `*.com`, and bare `*` are rejected as too broad.
- `envName` must be uppercase `SCREAMING_SNAKE_CASE`
- `authType` values are exactly `api_key` or `oauth` (snake_case, NOT `apiKey`/`camelCase`)
- Unknown top-level keys or unknown keys inside a block → rejection

### Picking the right MCP transport

Two wire protocols are in use in the wild:
- **`http`** (newer, default): POST-based with optional SSE for server→client streams. What the MCP spec calls "Streamable HTTP". Most modern MCP servers (e.g., official GitHub, Slack, filesystem servers).
- **`sse`** (legacy): GET connects for server→client events; separate POST to a session endpoint for client→server messages. **Linear's `mcp.linear.app/sse` uses this.** Anthropic's older MCP servers also.

If you're unsure, `curl -H "Authorization: Bearer <token>" <url>` the endpoint:
- Response starts with `event: endpoint\ndata: /sse/message?sessionId=...` → **`sse`**
- Response is a JSON-RPC envelope or HTTP 405/406 → **`http`**

Getting the transport wrong means tool discovery silently returns zero tools and no `.ax/tools/<skill>/` commit lands. If the skill approves but the tools tree doesn't appear, re-check the transport.

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
