# Chat UI Dev Loop with Playwright Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Tier 0: Chat UI Dev Loop" to the ax-debug skill that enables fast visual iteration on the chat UI using Playwright MCP tools, with both real LLM and mock LLM modes.

**Architecture:** A shell script (`scripts/chat-dev.sh`) starts both the Vite dev server (HMR on port 5173) and `ax serve --port 8080` (subprocess sandbox). The Vite proxy forwards `/v1` API calls to the ax server. Claude uses Playwright MCP to navigate to `http://localhost:5173`, make code changes, and visually verify them via screenshots/snapshots. Mock mode uses the existing e2e mock server with a dev-specific ax config that rewrites LLM URLs.

**Tech Stack:** Bash script, Vite dev server, ax serve (subprocess), Playwright MCP

---

### Task 1: Create `scripts/chat-dev.sh`

**Files:**
- Create: `scripts/chat-dev.sh`

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  echo "Usage: $0 <command> [options]"
  echo ""
  echo "Commands:"
  echo "  start [--mock]   Start Vite dev server + ax server (real LLM by default)"
  echo "  stop             Stop all dev servers"
  echo "  status           Show running dev servers"
  echo ""
  echo "Options:"
  echo "  --mock           Use mock LLM server instead of real API"
  echo "  --port <port>    AX server port (default: 8080)"
  echo "  --config <path>  Custom ax.yaml config path"
}

PID_DIR="$ROOT_DIR/.chat-dev"

start_servers() {
  local mock=false
  local ax_port=8080
  local config_path=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mock) mock=true; shift ;;
      --port) ax_port="$2"; shift 2 ;;
      --config) config_path="$2"; shift 2 ;;
      *) echo "Unknown option: $1"; usage; exit 1 ;;
    esac
  done

  mkdir -p "$PID_DIR"

  # Check if already running
  if [[ -f "$PID_DIR/vite.pid" ]] && kill -0 "$(cat "$PID_DIR/vite.pid")" 2>/dev/null; then
    echo "Dev servers already running. Use '$0 stop' first."
    exit 1
  fi

  # Start mock server if requested
  if $mock; then
    echo "Starting mock LLM server..."
    local mock_port=9100
    node -e "
      import('$ROOT_DIR/tests/e2e/mock-server/index.js').then(m => {
        const server = m.createMockServer();
        server.listen($mock_port, () => console.log('Mock server on port $mock_port'));
      });
    " &
    echo $! > "$PID_DIR/mock.pid"
    sleep 1

    # Use dev config with url_rewrites if no custom config
    if [[ -z "$config_path" ]]; then
      config_path="$ROOT_DIR/ui/chat/ax-dev.yaml"
    fi
    echo "Mock LLM server started on port $mock_port"
  fi

  # Start ax server
  echo "Starting ax server on port $ax_port..."
  local serve_args=(serve --port "$ax_port")
  if [[ -n "$config_path" ]]; then
    serve_args+=(--config "$config_path")
  fi
  (cd "$ROOT_DIR" && NODE_NO_WARNINGS=1 npx tsx src/cli/index.ts "${serve_args[@]}") &
  echo $! > "$PID_DIR/ax.pid"

  # Wait for ax server to be ready
  echo "Waiting for ax server..."
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:$ax_port/health" >/dev/null 2>&1; then
      echo "AX server ready on port $ax_port"
      break
    fi
    if [[ $i -eq 30 ]]; then
      echo "AX server failed to start within 30s"
      stop_servers
      exit 1
    fi
    sleep 1
  done

  # Start Vite dev server
  echo "Starting Vite dev server..."
  (cd "$ROOT_DIR/ui/chat" && npx vite --host) &
  echo $! > "$PID_DIR/vite.pid"
  sleep 2

  echo ""
  echo "=== Chat UI Dev Loop Ready ==="
  echo "  Chat UI:   http://localhost:5173"
  echo "  AX Server: http://localhost:$ax_port"
  if $mock; then
    echo "  Mock LLM:  http://localhost:9100"
  fi
  echo ""
  echo "Edit files in ui/chat/src/ — Vite hot-reloads automatically."
  echo "Use 'npm run dev:chat stop' to shut down."
}

stop_servers() {
  echo "Stopping dev servers..."
  for pidfile in "$PID_DIR"/*.pid; do
    if [[ -f "$pidfile" ]]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        echo "  Stopped PID $pid ($(basename "$pidfile" .pid))"
      fi
      rm -f "$pidfile"
    fi
  done
  echo "All dev servers stopped."
}

show_status() {
  echo "Chat UI Dev Loop Status:"
  for pidfile in "$PID_DIR"/*.pid; do
    if [[ -f "$pidfile" ]]; then
      local name pid
      name=$(basename "$pidfile" .pid)
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        echo "  $name: running (PID $pid)"
      else
        echo "  $name: dead (stale PID $pid)"
        rm -f "$pidfile"
      fi
    fi
  done
  if ! ls "$PID_DIR"/*.pid >/dev/null 2>&1; then
    echo "  No dev servers running."
  fi
}

# Cleanup on script exit (only during start)
cleanup() {
  stop_servers
}

case "${1:-}" in
  start)
    shift
    trap cleanup EXIT INT TERM
    start_servers "$@"
    # Keep script alive so trap works
    echo "Press Ctrl+C to stop all servers."
    wait
    ;;
  stop)
    stop_servers
    ;;
  status)
    show_status
    ;;
  *)
    usage
    exit 1
    ;;
esac
```

**Step 2: Make it executable**

Run: `chmod +x scripts/chat-dev.sh`

**Step 3: Verify the script parses correctly**

Run: `bash -n scripts/chat-dev.sh`
Expected: No output (no syntax errors)

---

### Task 2: Create `ui/chat/ax-dev.yaml` for mock mode

**Files:**
- Create: `ui/chat/ax-dev.yaml`

**Step 1: Write the minimal dev config**

This config is only used in `--mock` mode. It rewrites the OpenRouter URL to hit the local mock server, and uses minimal providers to avoid needing real credentials.

```yaml
# Minimal ax config for chat UI development with mock LLM.
# Used by: npm run dev:chat -- --mock
agent: pi-coding-agent
models:
  default:
    - openrouter/google/gemini-3-flash-preview
profile: yolo
providers:
  memory: disabled
  scanner: disabled
  database: sqlite
  channels: []
  web:
    extract: disabled
    search: disabled
  browser: disabled
  credentials: keychain
  audit: disabled
  sandbox: subprocess
  scheduler: disabled
  screener: disabled
sandbox:
  timeout_sec: 300
  memory_mb: 1024
scheduler:
  active_hours:
    start: "07:00"
    end: "23:00"
    timezone: America/New_York
  max_token_budget: 4096
  heartbeat_interval_min: 30
url_rewrites:
  "https://openrouter.ai": "http://localhost:9100"
```

**Step 2: Verify the config parses**

Run: `node -e "import('./src/config.js').then(m => { try { m.loadConfig('ui/chat/ax-dev.yaml'); console.log('OK'); } catch(e) { console.error(e.message); } })"`

Note: This may fail if some providers don't have `disabled` as a valid enum value. If so, check `src/host/provider-map.ts` for valid provider names and adjust. The key providers we need are `sandbox: subprocess` and `database: sqlite`. All others should use whatever "disabled" or "none" variant is available.

---

### Task 3: Add `dev:chat` npm script

**Files:**
- Modify: `package.json` (root)

**Step 1: Add the script**

Add to the `"scripts"` section of root `package.json`:

```json
"dev:chat": "bash scripts/chat-dev.sh"
```

**Step 2: Verify the script is accessible**

Run: `npm run dev:chat -- --help 2>&1 | head -5`
Expected: Usage text from chat-dev.sh

---

### Task 4: Add `.chat-dev` to `.gitignore`

**Files:**
- Modify: `.gitignore`

**Step 1: Add the PID directory to gitignore**

Append to `.gitignore`:

```
# Chat UI dev loop PID files
.chat-dev/
```

---

### Task 5: Update `ax-debug` skill with Tier 0

**Files:**
- Modify: `.claude/skills/ax-debug/SKILL.md`

**Step 1: Update the skill description frontmatter**

Change the description to include chat UI dev:

```yaml
---
name: ax-debug
description: Use when debugging k8s-related issues, NATS IPC problems, HTTP IPC problems, workspace release failures, chat UI development iteration, or any issue in the sandbox/host/agent communication pipeline — starts with chat UI dev loop or e2e test infrastructure for fast repro, falls back to full kind cluster or local process harnesses only when needed
---
```

**Step 2: Update the overview**

Replace the overview section to add Tier 0 before the existing tiers:

```markdown
## Overview

Four debugging/development tiers, in order of preference:

0. **Chat UI dev loop** (`scripts/chat-dev.sh`) — Vite HMR + local ax server + Playwright MCP for visual verification. **Start here for UI work.** Edit → hot-reload → screenshot → iterate in seconds.
1. **E2E test infrastructure** (`tests/e2e/`) — Automated vitest suite with mock providers, scripted LLM responses, and a kind cluster managed by `global-setup.ts`. **Start here for backend bugs.** Fastest iteration, deterministic, CI-friendly.
2. **Kind cluster dev loop** (`scripts/k8s-dev.sh`) — Real k8s pods with host volume mounts for ~5s iteration. Use this when you need production-parity pod behavior.
3. **Local process harnesses** (`run-http-local.ts` / `run-nats-local.ts`) — Spawns child processes with NATS env. Use this for IPC debugging without k8s overhead.

**For chat UI work, always use Tier 0.** For backend bugs, try Tier 1 first. Only escalate when the bug genuinely requires real k8s infrastructure or manual debugging.
```

**Step 3: Add the full Tier 0 section**

Insert after the overview and before the existing Tier 1 section:

```markdown
---

## Tier 0: Chat UI Dev Loop

Fast visual iteration on the chat UI using Vite HMR and Playwright MCP. Two modes: real LLM (uses OpenRouter + Gemini Flash, costs fractions of a cent) or mock LLM (free, deterministic).

### Quick Start

```bash
# Real LLM mode (uses OPENROUTER_API_KEY from env / .env)
npm run dev:chat start

# Mock LLM mode (no API key needed, scripted responses)
npm run dev:chat start --mock

# Stop everything
npm run dev:chat stop
```

This starts:
- **Vite dev server** on `http://localhost:5173` — serves the chat UI with hot module replacement
- **AX server** on `http://localhost:8080` — subprocess sandbox, handles `/v1/chat/completions` + session APIs
- (Mock mode only) **Mock LLM server** on `http://localhost:9100` — scripted OpenRouter responses

### Architecture

```
Browser (Playwright MCP)
  ↓ http://localhost:5173
Vite Dev Server (HMR, port 5173)
  ├── Serves ui/chat/src/ with hot-reload
  └── Proxies /v1/* → http://localhost:8080
        ↓
AX Server (subprocess sandbox, port 8080)
  ├── /v1/chat/completions — completion endpoint
  ├── /v1/chat/sessions — session CRUD
  ├── /v1/chat/sessions/:id/history — conversation history
  └── LLM calls → OpenRouter API (real) or localhost:9100 (mock)
```

### Visual Verification Workflow (Claude + Playwright MCP)

This is the core loop for iterating on chat UI changes:

```
1. Start servers:    npm run dev:chat start
2. Open browser:     playwright__browser_navigate → http://localhost:5173
3. Take snapshot:    playwright__browser_snapshot (see current DOM state)
   or screenshot:    playwright__browser_take_screenshot (visual capture)
4. Edit code:        Modify files in ui/chat/src/ (Vite hot-reloads automatically)
5. Verify change:    playwright__browser_snapshot or playwright__browser_take_screenshot
6. If not right:     Go to step 4
7. Test interaction: playwright__browser_click, playwright__browser_fill_form, etc.
8. Done:             npm run dev:chat stop
```

### Key Playwright MCP Actions

| Action | When to use |
|--------|-------------|
| `browser_navigate` | Open `http://localhost:5173` at start |
| `browser_snapshot` | See current DOM structure (fast, text-based) |
| `browser_take_screenshot` | Visual capture to verify styling/layout |
| `browser_click` | Click buttons, thread items, etc. |
| `browser_fill_form` | Type messages in the composer |
| `browser_press_key` | Submit with Enter, keyboard shortcuts |
| `browser_wait_for` | Wait for streaming response to complete |
| `browser_console_messages` | Check for JS errors |

### Typical Workflows

#### Fixing a styling issue

```text
1. npm run dev:chat start
2. Navigate to http://localhost:5173
3. Screenshot → identify the problem
4. Edit ui/chat/src/components/thread.tsx (or index.css)
5. Screenshot → verify fix (Vite HMR applied change)
6. Stop servers
```

#### Testing chat interaction

```text
1. npm run dev:chat start (real LLM mode)
2. Navigate to http://localhost:5173
3. Click "New Chat" button
4. Type a message in composer, press Enter
5. Wait for streaming response
6. Screenshot to verify message rendering
7. Check thread list shows new conversation
```

#### Testing with mock responses

```text
1. npm run dev:chat start --mock
2. Navigate to http://localhost:5173
3. Send a message — gets scripted mock response
4. Useful for testing UI with predictable content
5. No API costs, no network dependency
```

### Chat UI File Map

| File | What it controls |
|------|-----------------|
| `ui/chat/src/App.tsx` | Main layout — sidebar + thread area |
| `ui/chat/src/components/thread.tsx` | Message display, composer, streaming |
| `ui/chat/src/components/thread-list.tsx` | Sidebar thread list, "New Chat" button |
| `ui/chat/src/components/markdown-text.tsx` | Markdown rendering in messages |
| `ui/chat/src/lib/useAxChatRuntime.tsx` | Runtime hook — connects UI to AX backend |
| `ui/chat/src/lib/thread-list-adapter.ts` | Fetches threads from `/v1/chat/sessions` |
| `ui/chat/src/lib/history-adapter.ts` | Loads conversation history |
| `ui/chat/src/index.css` | Tailwind styles, theming |
| `ui/chat/tailwind.config.js` | Tailwind theme configuration |

### Server-side Changes

UI-only changes (components, styles) hot-reload instantly via Vite. Server-side changes require a restart:

| Change type | Action needed |
|---|---|
| `ui/chat/src/**` | Nothing — Vite HMR handles it |
| `src/host/server-chat-api.ts` | Restart: `npm run dev:chat stop && npm run dev:chat start` |
| `src/host/server-chat-ui.ts` | Not used in dev mode (Vite serves files directly) |
| `src/host/server-completions.ts` | Restart server |

### When NOT to use Tier 0

- Backend IPC bugs → use Tier 1 (e2e tests)
- k8s-specific behavior → use Tier 2 (kind cluster)
- Need to debug agent process → use Tier 3 (local harness with `--inspect`)

### Key Files

| File | Purpose |
|------|---------|
| `scripts/chat-dev.sh` | Start/stop/status for dev servers |
| `ui/chat/ax-dev.yaml` | Minimal config for mock LLM mode |
| `ui/chat/vite.config.ts` | Vite config with `/v1` proxy to port 8080 |
| `ui/chat/src/` | Chat UI React source |
```

---

### Task 6: Add `.chat-dev/` to `.gitignore`

Already covered in Task 4.

---

### Task 7: Verify the full workflow end-to-end

**Step 1: Start in real mode**

Run: `npm run dev:chat start`
Expected: Both servers start, health check passes, URLs printed

**Step 2: Verify Vite is serving**

Run: `curl -sf http://localhost:5173 | head -5`
Expected: HTML content from the chat UI

**Step 3: Verify AX server is healthy**

Run: `curl -sf http://localhost:8080/health`
Expected: `{"status":"ok"}` or similar

**Step 4: Verify API proxy works**

Run: `curl -sf http://localhost:5173/v1/chat/sessions`
Expected: JSON response (proxied through Vite to ax server)

**Step 5: Stop servers**

Run: `npm run dev:chat stop`
Expected: All processes stopped

---

### Task 8: Commit

```bash
git add scripts/chat-dev.sh ui/chat/ax-dev.yaml package.json .gitignore .claude/skills/ax-debug/SKILL.md
git commit -m "feat(chat): add Tier 0 chat UI dev loop with Playwright MCP support

Add scripts/chat-dev.sh for starting Vite + ax server together,
ui/chat/ax-dev.yaml for mock LLM mode, and update ax-debug skill
with visual verification workflow using Playwright MCP tools."
```

---

## Notes

- The mock server reuse from `tests/e2e/mock-server/` depends on those files being importable as ES modules. If they aren't (they're currently TypeScript), the mock mode startup in `chat-dev.sh` will need to use `tsx` instead of `node`. Adjust at implementation time.
- The `ax-dev.yaml` provider values (`disabled`, etc.) need validation against `PROVIDER_MAP` — some providers may not have a `disabled` variant. Check and use whatever "no-op" name is available (e.g., `none`, `disabled`, `noop`).
- Vite dev server defaults to port 5173 but will auto-increment if occupied.
