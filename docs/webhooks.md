# Webhooks

Inbound webhooks let external services (GitHub, Stripe, monitoring tools, your CI pipeline — basically anything that can POST JSON) trigger AX agent runs. Instead of writing template engines or transform scripts, we use an LLM to reshape incoming payloads into agent prompts.

Yes, we're using AI to parse webhook payloads. It's surprisingly good at it.

## How It Works

```
External service → POST /webhooks/<name> → Bearer token auth → LLM transform → Agent run
```

1. An external service sends a POST request to `/webhooks/<name>`
2. AX checks the bearer token
3. AX loads `~/.ax/webhooks/<name>.md` — a markdown file that tells a fast LLM how to interpret the payload
4. The LLM reads the payload + your instructions and returns either:
   - A structured JSON object with a `message` field (triggers an agent run)
   - `null` (skip this event — we don't need to respond to every star on GitHub)
5. AX dispatches the agent run asynchronously and returns `202 { runId }` immediately

## Configuration

Add this to your `ax.yaml`:

```yaml
webhooks:
  enabled: true
  token: "your-secret-token-here"  # gitleaks:allow
```

That's the minimum. Here are all the options:

```yaml
webhooks:
  enabled: true
  token: "your-secret-token-here"       # Required. Used for Bearer auth. gitleaks:allow
  path: "/webhooks"                      # Optional. URL prefix (default: /webhooks).
  max_body_bytes: 262144                 # Optional. Max payload size (default: 256KB).
  model: "claude-haiku-4-5-20251001"     # Optional. LLM for transforms (default: fast chain).
  allowed_agent_ids:                     # Optional. Restrict which agents webhooks can target.
    - "main"
    - "devops"
```

The token should be long and random. We recommend at least 32 characters. Store it somewhere safe — treat it like an API key, because that's what it is.

## Writing Transform Files

Transform files live at `~/.ax/webhooks/<name>.md`. The filename (minus `.md`) becomes the webhook name in the URL.

A transform file is a markdown document that tells the LLM how to interpret payloads from a specific source. Think of it as a system prompt for webhook parsing.

The LLM receives:
- **System prompt:** Your transform file + a preamble explaining the output format
- **User content:** `{ headers, payload }` — the raw HTTP headers and JSON body

The LLM must return either:
- A JSON object with at least `"message"` (string) — the prompt for the agent
- Optional fields: `"agentId"`, `"sessionKey"`, `"model"`, `"timeoutSec"`
- The literal `null` — meaning "ignore this event"

### Example: GitHub

Create `~/.ax/webhooks/github.md`:

```markdown
# GitHub Webhook Transform

You receive GitHub webhook events. The `x-github-event` header tells you the event type.

## Push events
When `headers.x-github-event` is "push":
- message: Summarize the push: who pushed, how many commits, to which branch,
  and the head commit message.
- agentId: "main"

## Issue events
When `headers.x-github-event` is "issues" and `payload.action` is "opened":
- message: Describe the new issue: number, title, body (first 500 chars), and who opened it.
- agentId: "main"

## Pull request events
When `headers.x-github-event` is "pull_request" and `payload.action` is "opened":
- message: Describe the new PR: number, title, body (first 500 chars), base/head branches,
  and author.
- agentId: "main"

## Everything else
Return null to ignore.
```

Then configure your GitHub repo webhook to point at:
```
https://your-ax-host:port/webhooks/github
```

With the Authorization header:
```
Bearer your-secret-token-here  # gitleaks:allow
```

### Example: Stripe

Create `~/.ax/webhooks/stripe.md`:

```markdown
# Stripe Webhook Transform

You receive Stripe webhook events. The event type is in `payload.type`.

## Payment succeeded
When `payload.type` is "payment_intent.succeeded":
- message: "Payment received: $[amount/100] from [customer email].
  Payment intent: [payload.data.object.id]."
- agentId: "main"

## Payment failed
When `payload.type` is "payment_intent.payment_failed":
- message: "Payment failed for [customer email]. Error: [last_payment_error.message].
  This needs attention."
- agentId: "main"

## Subscription events
When `payload.type` starts with "customer.subscription":
- message: Summarize the subscription change: customer, plan, status, and what changed.
- agentId: "main"

## Everything else
Return null.
```

### Example: Generic (monitoring alert)

Create `~/.ax/webhooks/alerts.md`:

```markdown
# Alert Webhook Transform

You receive monitoring alerts. Extract the essential information.

For any alert payload:
- message: Summarize what's happening: severity, affected service, description,
  and any relevant metrics. Be concise but include enough context for the agent
  to understand the situation.
- agentId: "main"
- timeoutSec: 300

If the alert looks like a test or informational (severity "info" or "debug"),
return null.
```

## Testing with curl

```bash
# Test your webhook locally
TOKEN="your-secret-token-here"  # gitleaks:allow
curl -X POST http://localhost:8080/webhooks/github \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{
    "ref": "refs/heads/main",
    "pusher": {"name": "alice"},
    "commits": [{"message": "fix: resolve login bug"}],
    "head_commit": {"message": "fix: resolve login bug"}
  }'

# Expected: 202 {"ok":true,"runId":"webhook-a1b2c3d4"}
```

```bash
# Test skip behavior (should return 204)
curl -X POST http://localhost:8080/webhooks/github \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: watch" \
  -d '{"action": "starred"}'

# Expected: 204 (no content)
```

## Security Considerations

This is the serious part — no jokes here.

- **Bearer tokens only.** We don't support tokens in query strings (they leak in server logs and browser history). AX will reject requests that try.
- **Rate limiting on auth failures.** 20 failed auth attempts from the same IP within 60 seconds triggers a lockout. This stops brute-force attacks without blocking legitimate traffic.
- **Timing-safe token comparison.** We use `crypto.timingSafeEqual` to prevent timing attacks on the token comparison.
- **All webhook payloads are taint-tagged.** They enter the system marked as external content. The taint budget tracks them and will flag if tainted content appears in unexpected places.
- **Audit logging.** Every webhook receipt, auth failure, and dispatch is audit-logged.
- **Path traversal protection.** Webhook names are sanitized via `safePath()` before constructing file paths. You can't trick AX into loading `../../../etc/passwd.md`.
- **HMAC signature verification is NOT implemented yet.** For v1, we rely on bearer tokens. Services like GitHub offer HMAC signature verification — that's on the roadmap.
- **The LLM transform runs on the host side**, not in a sandbox. The payload never enters an agent container until after it's been transformed and validated.

## How the LLM Transform Works (For the Curious)

The transform uses a fast model (default: Haiku) to convert raw payloads into structured output. The system prompt includes your transform file plus a preamble that constrains the output format. The LLM's response is:

1. Parsed as JSON (if it's not valid JSON, the webhook returns 500)
2. Validated against a strict Zod schema (must have `message`, optional fields are typed)
3. Taint-tagged as external content
4. Dispatched to `processCompletion` as an async agent run

The webhook returns `202` immediately — the agent run happens in the background. Check the event stream (`GET /v1/events`) or audit logs for results.
