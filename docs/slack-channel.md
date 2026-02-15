# Slack Channel Setup

Connect AX to Slack so you can message your agent from any channel, DM, or thread. It uses Slack's **Socket Mode** — no public URLs, no inbound ports, no nginx configs. Just a WebSocket connection from your machine to Slack's servers.

## Prerequisites

You'll need a Slack app with Socket Mode enabled. Here's the short version:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Under **Socket Mode**, flip it on and generate an **App-Level Token** with the `connections:write` scope. Save this — it's your `SLACK_APP_TOKEN`.
3. Under **OAuth & Permissions**, add these **Bot Token Scopes**:
   - `chat:write` — send messages
   - `im:history` — read DMs
   - `im:read` — know which DMs exist
   - `channels:history` — read channel messages (for @mentions)
   - `app_mentions:read` — respond to @mentions
   - `files:read` — read file attachments (optional, only if you want media support)
   - `files:write` — upload file attachments (optional, only if you want to send files)
4. Under **Event Subscriptions**, subscribe to these **bot events**:
   - `message.im` — DMs to the bot
   - `app_mention` — @mentions in channels
5. Install the app to your workspace. Copy the **Bot User OAuth Token** — that's your `SLACK_BOT_TOKEN`.

## Environment Variables

Set these before starting AX:

```bash
export SLACK_BOT_TOKEN=xoxb-your-bot-token
export SLACK_APP_TOKEN=xapp-your-app-token
```

These never enter the agent sandbox. The host process uses them to maintain the Slack connection, and credentials stay on your side of the trust boundary. That's the whole point.

## Configuration

Add `slack` to your channels list in `ax.yaml`:

```yaml
providers:
  channels:
    - slack
```

That's the minimum. AX will connect to Slack with sensible defaults: DMs are open, channel messages require an @mention, and attachments up to 20MB are accepted.

### Access Control

Want more control over who can talk to your agent? Add a `channel_config` section:

```yaml
channel_config:
  slack:
    dm_policy: open          # "open", "allowlist", or "disabled"
    allowed_users:           # only used when dm_policy is "allowlist"
      - U01ABCDEF
      - U02GHIJKL
    require_mention: true    # in channels, only respond to @mentions
```

The three DM policies:

| Policy | What happens |
|--------|-------------|
| `open` | Anyone in the workspace can DM the bot. This is the default. |
| `allowlist` | Only Slack user IDs listed in `allowed_users` can DM the bot. Everyone else gets ignored. |
| `disabled` | No DMs at all. The bot only responds to @mentions in channels. |

Channel messages always require an @mention by default (controlled by `require_mention`). This prevents the bot from jumping into every conversation uninvited — which is the kind of behavior that gets bots removed from workspaces.

### Attachment Filtering

You can restrict what files the bot will accept:

```yaml
channel_config:
  slack:
    max_attachment_bytes: 10485760   # 10MB (default is 20MB)
    allowed_mime_types:
      - "text/*"
      - "image/*"
      - "application/pdf"
```

MIME patterns support wildcards — `text/*` matches `text/plain`, `text/csv`, etc. Files that exceed the size limit or don't match an allowed type are silently dropped. If `allowed_mime_types` is omitted, all file types are accepted (up to the size limit).

## How It Works

Once connected, AX handles two types of Slack events:

- **DMs** (`message.im`): Direct messages to the bot. No @mention needed — if someone DMs the bot, they obviously want to talk to it.
- **@mentions** (`app_mention`): Messages in channels that mention the bot. AX strips the `@bot` mention from the text before processing.

Each conversation gets a **session** based on context:

| Context | Session Scope | What it means |
|---------|--------------|---------------|
| DM | `dm` | One-on-one conversation with the bot |
| Channel message | `channel` | A message in a public/private channel |
| Thread reply | `thread` | A threaded conversation (has a parent channel session) |

Thread sessions maintain context within their thread — so the agent remembers what you talked about earlier in that thread without mixing it up with other conversations in the same channel.

## Full Example

```yaml
# ax.yaml
profile: balanced

providers:
  llm: anthropic
  memory: sqlite
  scanner: patterns
  channels:
    - slack
  audit: sqlite
  sandbox: subprocess
  credentials: env
  skills: readonly
  web: fetch
  browser: none
  scheduler: none

channel_config:
  slack:
    dm_policy: allowlist
    allowed_users:
      - U01MYUSERID
    require_mention: true
    max_attachment_bytes: 10485760
    allowed_mime_types:
      - "text/*"
      - "image/*"
```

## Troubleshooting

**"Slack channel requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables"**
You're missing one or both tokens. Double-check that both are exported in your shell before running `ax serve`.

**Bot doesn't respond to DMs**
Check your `dm_policy`. If it's `allowlist`, make sure your Slack user ID (not your username — the `U01ABCDEF` thing) is in the `allowed_users` list. If it's `disabled`, well, that's working as intended.

**Bot doesn't respond to @mentions in channels**
Make sure you've subscribed to the `app_mention` event in your Slack app settings, and that the bot has been invited to the channel (`/invite @botname`).

**Messages are getting cut off**
Slack has a 4,000-character limit per message. AX automatically splits longer responses into multiple messages, breaking at newline boundaries when possible. If you're seeing weird splits, it's Slack's limit, not ours.

**Attachments aren't coming through**
Check `max_attachment_bytes` and `allowed_mime_types` in your config. Files that don't match get silently filtered. Also make sure the bot has the `files:read` scope.
