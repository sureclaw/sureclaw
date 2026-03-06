---
name: ax-acceptance-test
description: Use when testing a major feature against its design plan — designs acceptance tests, runs them against a live AX server with real LLM calls, analyzes failures, and creates a prioritized fix list
---

## Overview

AX features were implemented from plan documents, and many have bugs, gaps, or design mismatches that unit tests don't catch because they use mocked LLMs and in-memory harnesses. Acceptance tests bridge this gap by validating features against their **original design goals** using a real running AX server with real LLM calls.

This skill walks you through a 5-phase workflow: pick a feature (or run all), design tests from the plan's acceptance criteria, run them live, analyze failures, and produce a fix list.

Tests run against **both** environments **in parallel**:
- **Local** — AX server on the host machine (seatbelt sandbox, inprocess eventbus)
- **K8s** — AX server deployed to a kind cluster (subprocess sandbox, NATS eventbus, PostgreSQL storage)

All features are tested in parallel using separate agents. Each feature gets two agents (one local, one k8s) that run simultaneously. The same test plans work for both environments — only the send commands and side-effect checks differ.

## When to use this skill

- A feature was implemented from a plan and you want to verify it actually works end-to-end
- You suspect a feature has gaps between what the plan specified and what was built
- You want to validate a subsystem before building on top of it
- After a refactor, to confirm nothing regressed against original design intent
- You want to run all acceptance tests across all features in parallel

## Phase 1: Feature Selection

**Ask the user** which feature(s) to test:

- **Single feature** — Pick one from the table below
- **Run all** — Discover all feature directories in `tests/acceptance/` (skip `fixtures/`) and run them all in parallel

If the user says "run all" or "run everything", skip the feature table and go straight to discovery (see Phase 3: Feature Discovery).

If the user wants to pick a specific feature, present this reference table of testable features grouped by area. If the user isn't sure, suggest starting with a feature they recently had trouble with.

### Foundational / Reference

Use the "ax" skill to learn more about the system architecture and how it works

All plan files live in `docs/plans/`. After the user picks a feature, **read the plan document(s)** — both design and implementation docs if they exist as a pair.

## Phase 2: Acceptance Test Design

After reading the plan, extract every **acceptance criterion** — these are the "must" and "should" statements, success criteria, design goals, invariants, and behavioral requirements stated in the plan.

### Categorize each criterion

| Category | What it tests | How it's verified |
|----------|--------------|-------------------|
| **Structural** | Code shape, file existence, interface contracts, invariants | Read source files, grep for patterns, check types |
| **Behavioral** | Feature works correctly via chat interaction | Send messages to AX server, check response + side effects |
| **Integration** | Multi-step flows, state persistence, cross-component interaction | Multi-turn conversations with session persistence, check DB/files |

### Design test cases

For each criterion, write a test case using the templates below. **Prefer structural tests** — they're deterministic and catch real implementation gaps. Use behavioral tests for things that can only be verified through actual agent interaction.

#### Structural Test Template

```markdown
### ST-<number>: <descriptive name>

**Criterion:** <quote or paraphrase from the plan>
**Plan reference:** <plan filename, section heading>

**Verification steps:**
1. Read `<file path>` and check that <specific pattern/interface/export exists>
2. Grep for `<pattern>` in `<directory>` to verify <what>
3. Check that <invariant> holds across <scope>

**Expected outcome:**
- [ ] <specific, checkable assertion>
- [ ] <another assertion>

**Pass/Fail:** _pending_
```

#### Behavioral Test Template

```markdown
### BT-<number>: <descriptive name>

**Criterion:** <quote or paraphrase from the plan>
**Plan reference:** <plan filename, section heading>

**Setup:**
- <any config changes, seed data, or prerequisites>

**Chat script:**
1. Send: `<exact message to send>`
   Expected behavior: <what the agent should do, not exact wording>
   Structural check: <observable side effect to verify — file, DB entry, audit log>

2. Send: `<follow-up message if multi-turn>`
   Expected behavior: <what should happen>
   Structural check: <what to verify>

**Expected outcome:**
- [ ] Agent response demonstrates <behavior>
- [ ] <file/DB/audit entry> was created/modified with <expected content>
- [ ] No <negative outcome — errors, crashes, leaked data>

**Pass/Fail:** _pending_
```

#### Integration Test Template

```markdown
### IT-<number>: <descriptive name>

**Criterion:** <quote or paraphrase from the plan>
**Plan reference:** <plan filename, section heading>

**Setup:**
- <config, seed data, running services>
- Session ID: `acceptance:<feature>:it<number>` (3+ colon-separated segments required)

**Sequence:**
1. [Step description]
   Action: <send message / check file / call API>
   Verify: <expected state after this step>

2. [Step description]
   Action: <next action>
   Verify: <expected state>

(continue for all steps)

**Expected final state:**
- [ ] <end-to-end assertion>
- [ ] <state persistence assertion>

**Pass/Fail:** _pending_
```

### Save the test plan

Write all test cases to `tests/acceptance/<feature-name>/test-plan.md` with this structure:

```markdown
# Acceptance Tests: <Feature Name>

**Plan document(s):** <filename(s)>
**Date designed:** <YYYY-MM-DD>
**Total tests:** <count> (ST: <n>, BT: <n>, IT: <n>)

## Summary of Acceptance Criteria

<Numbered list of all criteria extracted from the plan>

## Structural Tests

<ST-1, ST-2, etc.>

## Behavioral Tests

<BT-1, BT-2, etc.>

## Integration Tests

<IT-1, IT-2, etc.>
```

**Before executing, present the test plan to the user for review.** They may want to skip certain tests, adjust expectations, or add criteria you missed.

## Phase 3: Test Execution

### Parallel Execution Architecture

Tests run in parallel at two levels:

1. **Across features** — Each feature directory gets its own pair of agents, all running simultaneously
2. **Across environments** — Each feature's local and k8s tests run in parallel via two separate agents

```
Lead Agent (you)
├── Shared K8s setup (build image once)
├── Feature: cortex
│   ├── Agent: cortex-local   (local env setup + structural + behavioral + integration)
│   └── Agent: cortex-k8s     (k8s env setup + behavioral + integration)
├── Feature: plainjob-scheduler
│   ├── Agent: plainjob-scheduler-local
│   └── Agent: plainjob-scheduler-k8s
├── Feature: llm-webhook-transforms
│   ├── Agent: llm-webhook-transforms-local
│   └── Agent: llm-webhook-transforms-k8s
└── ... (all features in parallel)
```

**Key rules:**
- Each local agent gets its own `TEST_HOME` (isolated `/tmp/` directory) — no shared state
- Each k8s agent gets its own unique namespace — no shared state
- Structural tests run **once per feature**, by the **local agent** only (they're environment-independent)
- Behavioral and integration tests run **sequentially within each agent** (they share that agent's server/DB)
- All agents across all features run **in parallel** (they don't share servers or databases)

### Feature Discovery

To discover all testable features:

```bash
# List all feature directories (skip fixtures)
ls -d tests/acceptance/*/ | grep -v fixtures
```

Only features with a `test-plan.md` file are executable. Features without a test plan need Phase 2 first.

When running all features, the lead agent:
1. Discovers all feature directories with `test-plan.md` files
2. Performs shared k8s setup once (image build + load)
3. Spawns all agents in parallel via the Task tool
4. Waits for all agents to complete
5. Collects results and runs Phase 4 (failure analysis) and Phase 5 (fix list)

### Shared K8s Prerequisites

Before spawning any k8s agents, the **lead agent** performs these one-time steps:

```bash
# 1. Check for running kind cluster
KIND_CLUSTER=$(kind get clusters 2>/dev/null | head -1)
KUBE_CTX="kind-$KIND_CLUSTER"
echo "Using kind cluster: $KIND_CLUSTER (context: $KUBE_CTX)"

# 2. Build and load AX image (done once, shared by all k8s agents)
npm run build
docker build -t ax/host:test -f container/Dockerfile .
kind load docker-image ax/host:test --name "$KIND_CLUSTER"

# 3. Update Helm dependencies (done once)
helm dependency update charts/ax

# 4. Read API keys from .env.test (passed to each k8s agent)
LLM_PROVIDER=$(grep -m1 'ANTHROPIC_API_KEY\|OPENROUTER_API_KEY\|OPENAI_API_KEY' .env.test | cut -d_ -f1 | tr '[:upper:]' '[:lower:]')
API_KEY=$(grep -m1 '_API_KEY=' .env.test | cut -d= -f2-)
```

Pass `KIND_CLUSTER`, `KUBE_CTX`, `LLM_PROVIDER`, and `API_KEY` to each k8s agent in its prompt. Skip k8s agents entirely if no kind cluster is available.

### Test fixtures

Acceptance tests use dedicated config, identity, and credentials files — never the user's `~/.ax`:

| File | Purpose |
|------|---------|
| `tests/acceptance/fixtures/ax.yaml` | Local test config — seatbelt sandbox, inprocess eventbus, sqlite storage |
| `tests/acceptance/fixtures/ax-k8s.yaml` | K8s test config — subprocess sandbox, nats eventbus, postgresql storage |
| `tests/acceptance/fixtures/kind-values.yaml` | Helm overrides for kind cluster — host + agent-runtime + PostgreSQL + NATS |
| `tests/acceptance/fixtures/IDENTITY.md` | Deterministic agent identity (neutral, concise, no emojis) |
| `tests/acceptance/fixtures/SOUL.md` | Deterministic agent personality (predictable, factual) |
| `.env.test` (project root) | API keys for tests — copy from `tests/acceptance/fixtures/.env.test.example` |

Edit `fixtures/ax.yaml` (local) or `fixtures/ax-k8s.yaml` (k8s) to change which models/providers the tests use.

Credentials live in `.env.test` in the project root (gitignored). Copy the example file and fill in your keys:
```bash
cp tests/acceptance/fixtures/.env.test.example .env.test
# Edit .env.test with your API keys
```

### Provider comparison

| Provider | Local (`ax.yaml`) | K8s (`ax-k8s.yaml`) |
|----------|-------------------|---------------------|
| sandbox | seatbelt | subprocess (in agent-runtime pod) |
| eventbus | inprocess | nats |
| storage | file | database (postgresql) |
| database | — | postgresql |
| memory | cortex | cortex |
| audit | file | database (postgresql) |
| credentials | plaintext | plaintext |
| skills | git | git |
| scheduler | plainjob | plainjob |
| screener | static | static |
| scanner | guardian | guardian |
| browser | none | none |
| web | none | none |

---

### Spawning agents

Use the **Task tool** to spawn all agents in a single message (maximizing parallelism). Each agent is a `general-purpose` subagent with `mode: "bypassPermissions"` so it can run bash commands without prompts.

#### Local agent prompt template

For each feature, spawn one local agent with this prompt:

```
You are running LOCAL acceptance tests for the "<FEATURE_NAME>" feature.

## Your job
1. Set up an isolated local AX server
2. Run ALL structural tests from the test plan (these only run in local, not k8s)
3. Run ALL behavioral tests sequentially
4. Run ALL integration tests sequentially
5. Write results to tests/acceptance/<FEATURE_NAME>/results-local.md
6. Tear down the server

## Test plan
Read the test plan from: tests/acceptance/<FEATURE_NAME>/test-plan.md

## Environment setup

FIXTURES="tests/acceptance/fixtures"
TEST_HOME="/tmp/ax-acceptance-local-<FEATURE_NAME>-$(date +%s)"
mkdir -p "$TEST_HOME/data"
cp "$FIXTURES/ax.yaml" "$TEST_HOME/ax.yaml"
cp .env.test "$TEST_HOME/.env"

## Start server
AX_HOME="$TEST_HOME" LOG_LEVEL=debug LOG_SYNC=1 NODE_NO_WARNINGS=1 \
  tsx src/cli/index.ts serve > "$TEST_HOME/server-stdout.log" 2>&1 &
SERVER_PID=$!

# Wait for ready (poll up to 30s)
for i in $(seq 1 30); do
  curl -sf --unix-socket "$TEST_HOME/ax.sock" http://localhost/health && break
  sleep 1
done

# Install test identity after server creates dirs
sleep 3
cp "$FIXTURES/IDENTITY.md" "$TEST_HOME/agents/main/agent/identity/IDENTITY.md"
cp "$FIXTURES/SOUL.md" "$TEST_HOME/agents/main/agent/identity/SOUL.md"
rm -f "$TEST_HOME/agents/main/agent/identity/BOOTSTRAP.md"
rm -f "$TEST_HOME/agents/main/agent/BOOTSTRAP.md"

## Sending messages
AX_HOME="$TEST_HOME" NODE_NO_WARNINGS=1 tsx src/cli/index.ts send --no-stream --session "$SESSION" "$MESSAGE"

## Session IDs — must have 3+ colon-separated segments
Example: acceptance:<FEATURE_NAME>:bt1

## Checking side effects
- Memory DB (items): sqlite3 "$TEST_HOME/data/memory/_store.db" "..."
- Memory DB (vectors): sqlite3 "$TEST_HOME/data/memory/_vec.db" "..."
- Memory files: Read "$TEST_HOME/data/memory/<filename>.md"
- Audit log: cat "$TEST_HOME/data/audit/audit.jsonl" (JSONL, one JSON object per line)
- Conversations: Files under "$TEST_HOME/data/conversations/" (JSONL per session)
- Sessions: Files under "$TEST_HOME/data/sessions/" (JSON per agent)
- Logs: Read "$TEST_HOME/data/ax.log"

## Cleanup
kill $SERVER_PID 2>/dev/null

## Results format
Write results to tests/acceptance/<FEATURE_NAME>/results-local.md using this format:

# Acceptance Test Results: <Feature Name>
**Date run:** <YYYY-MM-DD HH:MM>
**Server version:** <git commit hash>
**LLM provider:** <provider and model from ax.yaml>
**Environment:** Local (seatbelt sandbox, inprocess eventbus, sqlite storage)

## Summary
| Test | Category | Result | Notes |
|------|----------|--------|-------|
(all tests)

**Overall: X/Y passed**

## Detailed Results
(each test with evidence)

## Failures
(failures only, with full detail)
```

#### K8s agent prompt template

For each feature, spawn one k8s agent with this prompt:

```
You are running K8S acceptance tests for the "<FEATURE_NAME>" feature.

## Your job
1. Deploy AX to a unique k8s namespace
2. Run ALL behavioral tests sequentially (structural tests are handled by the local agent)
3. Run ALL integration tests sequentially
4. Write results to tests/acceptance/<FEATURE_NAME>/results-k8s.md
5. Tear down the k8s deployment

## Test plan
Read the test plan from: tests/acceptance/<FEATURE_NAME>/test-plan.md
Skip structural tests (ST-*) — those are environment-independent and run by the local agent.

## K8s environment
KIND_CLUSTER="<KIND_CLUSTER>"
KUBE_CTX="<KUBE_CTX>"
The Docker image is already built and loaded (done by lead agent).
Helm dependencies are already updated (done by lead agent).

## Setup

K8S_NS="ax-test-<FEATURE_NAME>-$(openssl rand -hex 4)"
PF_PORT=$(( 18080 + RANDOM % 10000 ))

# Use ax k8s init to create namespace, secrets, and values file
# (non-interactive mode with CLI flags)
tsx src/cli/index.ts k8s init \
  --preset small \
  --llm-provider "<LLM_PROVIDER>" \
  --api-key "<API_KEY>" \
  --database internal \
  --namespace "$K8S_NS" \
  --output "$K8S_NS-values.yaml"

# Deploy via Helm with generated values + kind-specific overrides
HELM_RELEASE="ax-$K8S_NS"
helm --kube-context "$KUBE_CTX" install "$HELM_RELEASE" charts/ax -n "$K8S_NS" \
  -f "$K8S_NS-values.yaml" \
  -f tests/acceptance/fixtures/kind-values.yaml \
  --set namespace.create=false

# Wait for all pods to be ready (PostgreSQL first, then host, then agent-runtime)
kubectl --context "$KUBE_CTX" -n "$K8S_NS" wait --for=condition=Ready pod \
  -l app.kubernetes.io/name=postgresql --timeout=120s
kubectl --context "$KUBE_CTX" -n "$K8S_NS" wait --for=condition=Ready pod \
  -l app.kubernetes.io/component=host --timeout=120s
kubectl --context "$KUBE_CTX" -n "$K8S_NS" wait --for=condition=Ready pod \
  -l app.kubernetes.io/component=agent-runtime --timeout=120s

# Get pod names
HOST_POD=$(kubectl --context "$KUBE_CTX" -n "$K8S_NS" get pod \
  -l app.kubernetes.io/component=host -o jsonpath='{.items[0].metadata.name}')
PG_POD=$(kubectl --context "$KUBE_CTX" -n "$K8S_NS" get pod \
  -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}')
AGENT_POD=$(kubectl --context "$KUBE_CTX" -n "$K8S_NS" get pod \
  -l app.kubernetes.io/component=agent-runtime -o jsonpath='{.items[0].metadata.name}')

# Install test identity on agent-runtime pod (where the agent process runs)
FIXTURES="tests/acceptance/fixtures"
kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec "$AGENT_POD" -- \
  mkdir -p /home/agent/.ax/agents/main/agent/identity
kubectl --context "$KUBE_CTX" -n "$K8S_NS" cp \
  "$FIXTURES/IDENTITY.md" "$AGENT_POD:/home/agent/.ax/agents/main/agent/identity/IDENTITY.md"
kubectl --context "$KUBE_CTX" -n "$K8S_NS" cp \
  "$FIXTURES/SOUL.md" "$AGENT_POD:/home/agent/.ax/agents/main/agent/identity/SOUL.md"

# Port-forward on unique port
kubectl --context "$KUBE_CTX" -n "$K8S_NS" port-forward svc/"$HELM_RELEASE"-host $PF_PORT:80 &
PF_PID=$!
sleep 3
curl -sf http://localhost:$PF_PORT/health && echo "K8S_SERVER_READY"

## Sending messages
curl -sf http://localhost:$PF_PORT/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"agent:main","messages":[{"role":"user","content":"'"$MESSAGE"'"}],"stream":false,"session_id":"'"$SESSION"'"}' \
  | jq -r '.choices[0].message.content'

## Session IDs — must have 3+ colon-separated segments
Example: acceptance:<FEATURE_NAME>:k8s:bt1

## Checking side effects
- Memory DB (items): kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $HOST_POD -- sqlite3 /home/agent/.ax/data/memory/_store.db "..."
- Memory DB (vectors): kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $HOST_POD -- sqlite3 /home/agent/.ax/data/memory/_vec.db "..."
- Memory files: kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $HOST_POD -- cat /home/agent/.ax/data/memory/<filename>.md
- Audit (PostgreSQL): kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10;"
- Conversations (PostgreSQL): kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM conversations;"
- Sessions (PostgreSQL): kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM sessions;"
- Logs: kubectl --context "$KUBE_CTX" -n "$K8S_NS" logs $HOST_POD

Note: If sqlite3 is not in the container for memory DB queries, use:
kubectl exec $HOST_POD -- node -e "const db = require('better-sqlite3')('<path>'); console.log(JSON.stringify(db.prepare('<query>').all()))"

## Teardown (ALWAYS do this)
kill $PF_PID 2>/dev/null
helm --kube-context "$KUBE_CTX" uninstall "$HELM_RELEASE" -n "$K8S_NS" 2>/dev/null
kubectl --context "$KUBE_CTX" delete namespace "$K8S_NS"
rm -f "$K8S_NS-values.yaml"

## Results format
Write results to tests/acceptance/<FEATURE_NAME>/results-k8s.md using this format:

# Acceptance Test Results: <Feature Name>
**Date run:** <YYYY-MM-DD HH:MM>
**Server version:** <git commit hash>
**LLM provider:** <provider and model from ax-k8s.yaml>
**Environment:** K8s/kind (subprocess sandbox, nats eventbus, postgresql storage)

## Summary
| Test | Category | Result | Notes |
|------|----------|--------|-------|
(behavioral and integration tests only — no structural)

**Overall: X/Y passed**

## Detailed Results
(each test with evidence)

## Failures
(failures only, with full detail)
```

### Spawning example

Here's how the lead agent spawns all agents for 3 features in a single message:

```
Use the Task tool 6 times in one message (all in parallel):

Task 1: subagent_type="general-purpose", name="cortex-local", mode="bypassPermissions"
  prompt: <local agent prompt for cortex>

Task 2: subagent_type="general-purpose", name="cortex-k8s", mode="bypassPermissions"
  prompt: <k8s agent prompt for cortex>

Task 3: subagent_type="general-purpose", name="plainjob-scheduler-local", mode="bypassPermissions"
  prompt: <local agent prompt for plainjob-scheduler>

Task 4: subagent_type="general-purpose", name="plainjob-scheduler-k8s", mode="bypassPermissions"
  prompt: <k8s agent prompt for plainjob-scheduler>

Task 5: subagent_type="general-purpose", name="llm-webhook-transforms-local", mode="bypassPermissions"
  prompt: <local agent prompt for llm-webhook-transforms>

Task 6: subagent_type="general-purpose", name="llm-webhook-transforms-k8s", mode="bypassPermissions"
  prompt: <k8s agent prompt for llm-webhook-transforms>
```

All 6 agents start simultaneously. Each manages its own environment setup, test execution, results recording, and teardown.

---

### Reference: Local environment setup

This section is reference material for the local agent prompts. You do not need to run these commands yourself — the local agents handle everything.

**CRITICAL**: Never run acceptance tests against the user's real `~/.ax` directory. Always create an isolated temporary home so tests don't pollute real data.

#### Setup

```bash
# Create isolated test home
FIXTURES="tests/acceptance/fixtures"
TEST_HOME="/tmp/ax-acceptance-local-<feature>-$(date +%s)"
mkdir -p "$TEST_HOME/data"

# Copy test config and credentials (from project, not from ~/.ax)
cp "$FIXTURES/ax.yaml" "$TEST_HOME/ax.yaml"
cp .env.test "$TEST_HOME/.env"

echo "Test home: $TEST_HOME"
```

After the server starts and creates the agent directory structure, **copy test identity files and remove bootstrap files** so the agent doesn't enter the first-run bootstrapping flow:

```bash
# Wait for server to create agent dirs, then install test identity
cp "$FIXTURES/IDENTITY.md" "$TEST_HOME/agents/main/agent/identity/IDENTITY.md"
cp "$FIXTURES/SOUL.md" "$TEST_HOME/agents/main/agent/identity/SOUL.md"
rm -f "$TEST_HOME/agents/main/agent/identity/BOOTSTRAP.md"
rm -f "$TEST_HOME/agents/main/agent/BOOTSTRAP.md"
```

All subsequent commands in the test session MUST set `AX_HOME=$TEST_HOME`. The test home path should be stored and reused throughout the entire test run.

#### Server management

Before running behavioral or integration tests, start the AX server in the isolated test home:

```bash
# LOG_SYNC=1 forces synchronous file writes so `tail -f` shows entries
# immediately. Without it, pino buffers ~4KB before flushing.
AX_HOME="$TEST_HOME" LOG_LEVEL=debug LOG_SYNC=1 NODE_NO_WARNINGS=1 \
  tsx src/cli/index.ts serve > "$TEST_HOME/server-stdout.log" 2>&1 &
SERVER_PID=$!

# Wait for ready (poll up to 30s)
for i in $(seq 1 30); do
  curl -sf --unix-socket "$TEST_HOME/ax.sock" http://localhost/health && break
  sleep 1
done

# Verify
curl -sf --unix-socket "$TEST_HOME/ax.sock" http://localhost/health \
  && echo "SERVER_READY" || echo "SERVER_FAILED_TO_START"
```

If the server fails to start, check `$TEST_HOME/data/ax.log` and `$TEST_HOME/server-stdout.log` for errors. Do not proceed with behavioral/integration tests if the server is down.

#### Cleanup

```bash
kill $SERVER_PID 2>/dev/null
# Optionally keep for debugging:
# rm -rf "$TEST_HOME"
```

---

### Reference: K8s environment setup

This section is reference material for the k8s agent prompts. The lead agent only performs the shared steps (image build, helm dep update). Each k8s agent handles its own namespace, deployment, and teardown.

**CRITICAL**: Each k8s agent MUST use a unique random namespace. This prevents collisions between parallel test runs.

#### Prerequisites (checked by lead agent)

- A running kind cluster (check with `kind get clusters`)
- `kubectl` CLI installed
- `helm` CLI installed
- `docker` running
- `.env.test` with API keys at project root

#### Per-feature setup (done by each k8s agent)

```bash
# 1. Generate unique namespace for this feature's test run
K8S_NS="ax-test-<feature>-$(openssl rand -hex 4)"

# 2. Pick a unique port for port-forwarding (avoid collisions with parallel agents)
PF_PORT=$(( 18080 + RANDOM % 10000 ))

# 3. Use ax k8s init to create namespace, secrets, and values file
#    Non-interactive mode with CLI flags — no manual kubectl create secret needed
tsx src/cli/index.ts k8s init \
  --preset small \
  --llm-provider "$LLM_PROVIDER" \
  --api-key "$API_KEY" \
  --database internal \
  --namespace "$K8S_NS" \
  --output "$K8S_NS-values.yaml"

# 4. Deploy via Helm with generated values + kind-specific overrides
HELM_RELEASE="ax-$K8S_NS"
helm --kube-context "$KUBE_CTX" install "$HELM_RELEASE" charts/ax -n "$K8S_NS" \
  -f "$K8S_NS-values.yaml" \
  -f tests/acceptance/fixtures/kind-values.yaml \
  --set namespace.create=false

# 5. Wait for all pods to be ready (PostgreSQL first, then host, then agent-runtime)
kubectl --context "$KUBE_CTX" -n "$K8S_NS" wait --for=condition=Ready pod \
  -l app.kubernetes.io/name=postgresql --timeout=120s
kubectl --context "$KUBE_CTX" -n "$K8S_NS" wait --for=condition=Ready pod \
  -l app.kubernetes.io/component=host --timeout=120s
kubectl --context "$KUBE_CTX" -n "$K8S_NS" wait --for=condition=Ready pod \
  -l app.kubernetes.io/component=agent-runtime --timeout=120s

# 6. Identify pods
HOST_POD=$(kubectl --context "$KUBE_CTX" -n "$K8S_NS" get pod \
  -l app.kubernetes.io/component=host \
  -o jsonpath='{.items[0].metadata.name}')
PG_POD=$(kubectl --context "$KUBE_CTX" -n "$K8S_NS" get pod \
  -l app.kubernetes.io/name=postgresql \
  -o jsonpath='{.items[0].metadata.name}')
AGENT_POD=$(kubectl --context "$KUBE_CTX" -n "$K8S_NS" get pod \
  -l app.kubernetes.io/component=agent-runtime \
  -o jsonpath='{.items[0].metadata.name}')

# 7. Install test identity on agent-runtime pod (where the agent process runs)
FIXTURES="tests/acceptance/fixtures"
kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec "$AGENT_POD" -- \
  mkdir -p /home/agent/.ax/agents/main/agent/identity
kubectl --context "$KUBE_CTX" -n "$K8S_NS" cp \
  "$FIXTURES/IDENTITY.md" "$AGENT_POD:/home/agent/.ax/agents/main/agent/identity/IDENTITY.md"
kubectl --context "$KUBE_CTX" -n "$K8S_NS" cp \
  "$FIXTURES/SOUL.md" "$AGENT_POD:/home/agent/.ax/agents/main/agent/identity/SOUL.md"

# 8. Port-forward on unique port
kubectl --context "$KUBE_CTX" -n "$K8S_NS" port-forward svc/"$HELM_RELEASE"-host $PF_PORT:80 &
PF_PID=$!

# 9. Health check
sleep 3
curl -sf http://localhost:$PF_PORT/health && echo "K8S_SERVER_READY"
```

#### Per-feature teardown (done by each k8s agent)

**Always tear down after tests complete**, regardless of pass/fail:

```bash
kill $PF_PID 2>/dev/null
helm --kube-context "$KUBE_CTX" uninstall "$HELM_RELEASE" -n "$K8S_NS" 2>/dev/null
kubectl --context "$KUBE_CTX" delete namespace "$K8S_NS"
rm -f "$K8S_NS-values.yaml"
```

Do NOT delete the kind cluster itself — it's shared across all features and test runs.

---

### Session ID format

AX requires session IDs with **3 or more colon-separated segments**. Two-segment IDs like `acceptance:bt1` will be rejected. Always use at least 3 segments:

```bash
# WRONG — will fail with "Invalid session_id"
--session "acceptance:bt1"

# CORRECT — 3+ colon-separated segments
--session "acceptance:cortex:bt1"
--session "acceptance:cortex:k8s:bt1"  # k8s variant
```

### Running structural tests

Structural tests are run by the **local agent only** (they're environment-independent). Execute directly using file reads and grep. For each structural test:
1. Read the specified files
2. Check for the expected patterns, interfaces, exports
3. Record **PASS** or **FAIL** with evidence (the actual content found or not found)

### Sending messages

Agents use the correct send command for their environment:

| Environment | Send command |
|-------------|-------------|
| **Local** | `AX_HOME="$TEST_HOME" NODE_NO_WARNINGS=1 tsx src/cli/index.ts send --no-stream --session "$SESSION" "$MESSAGE"` |
| **K8s** | `curl -sf http://localhost:$PF_PORT/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"agent:main","messages":[{"role":"user","content":"'"$MESSAGE"'"}],"stream":false,"session_id":"'"$SESSION"'"}'` |

For k8s, extract the response text from the JSON:
```bash
curl -sf http://localhost:$PF_PORT/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"agent:main","messages":[{"role":"user","content":"'"$MESSAGE"'"}],"stream":false,"session_id":"'"$SESSION"'"}' \
  | jq -r '.choices[0].message.content'
```

### Checking side effects

Agents use the correct commands for their environment:

| Check | Local | K8s |
|-------|-------|-----|
| Memory DB (items) | `sqlite3 "$TEST_HOME/data/memory/_store.db" "..."` | `kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $AGENT_POD -- sqlite3 /home/agent/.ax/data/memory/_store.db "..."` |
| Memory DB (vectors) | `sqlite3 "$TEST_HOME/data/memory/_vec.db" "..."` | `kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $AGENT_POD -- sqlite3 /home/agent/.ax/data/memory/_vec.db "..."` |
| Memory files | `cat "$TEST_HOME/data/memory/preferences.md"` | `kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $AGENT_POD -- cat /home/agent/.ax/data/memory/preferences.md` |
| Audit log | `cat "$TEST_HOME/data/audit/audit.jsonl"` | `kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10;"` |
| Conversations | Files under `$TEST_HOME/data/conversations/` (JSONL) | `kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM conversations;"` |
| Sessions | Files under `$TEST_HOME/data/sessions/` (JSON) | `kubectl --context "$KUBE_CTX" -n "$K8S_NS" exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM sessions;"` |
| Logs | `tail -f "$TEST_HOME/data/ax.log"` | `kubectl --context "$KUBE_CTX" -n "$K8S_NS" logs -f $HOST_POD` |

**Local vs k8s data layout:**
- **Local** uses file-based providers: audit is a JSONL file (`data/audit/audit.jsonl`), storage is flat files (`data/conversations/*.jsonl`, `data/sessions/*.json`). Memory (`cortex`) uses SQLite (`data/memory/_store.db`, `data/memory/_vec.db`) and markdown files (`data/memory/*.md`).
- **K8s** uses the `database` provider backed by PostgreSQL for both storage and audit. Query via `$PG_POD` with `psql`. Memory (`cortex`) uses SQLite files on the agent-runtime pod's local filesystem (where the agent process runs). If the pod has no `sqlite3` binary, use Node.js: `kubectl exec $AGENT_POD -- node -e "const db = require('better-sqlite3')('/home/agent/.ax/data/memory/_store.db'); console.log(JSON.stringify(db.prepare('SELECT * FROM items').all()))"`

### Running behavioral tests

**Run behavioral tests SEQUENTIALLY within each agent** to avoid shared-DB interference on that agent's server. Multiple concurrent requests to the same server can corrupt assertions (e.g., one test checks "exactly 1 item" while another is inserting).

Tests across different features run in parallel because each feature has its own isolated server.

For each behavioral test:
1. Complete any setup steps
2. Send each message using the appropriate send command for the environment
3. Capture the response
4. Check the structural side effects
5. Evaluate behavioral expectations using judgment (not exact string matching)
6. Record PASS or FAIL with evidence

### Running integration tests

Run integration tests SEQUENTIALLY within each agent for the same shared-DB reasons.

For each integration test:
1. Complete setup
2. Execute the sequence step by step, using a **persistent session ID** so conversation state carries over
3. After all steps, verify the expected final state
4. Record PASS or FAIL with evidence

### Recording results

Each agent writes results to its environment-specific file:

- **Local agents:** `tests/acceptance/<feature-name>/results-local.md`
- **K8s agents:** `tests/acceptance/<feature-name>/results-k8s.md`

Use this format:

```markdown
# Acceptance Test Results: <Feature Name>

**Date run:** <YYYY-MM-DD HH:MM>
**Server version:** <git commit hash>
**LLM provider:** <provider and model used>
**Environment:** <Local (seatbelt sandbox, inprocess eventbus, sqlite storage) | K8s/kind (subprocess sandbox, nats eventbus, postgresql storage)>

## Summary

| Test | Category | Result | Notes |
|------|----------|--------|-------|
| ST-1 | Structural | PASS/FAIL | <brief note> |
| BT-1 | Behavioral | PASS/FAIL | <brief note> |
| IT-1 | Integration | PASS/FAIL | <brief note> |

**Overall: <X>/<Y> passed**

## Detailed Results

### ST-1: <name>
**Result:** PASS/FAIL
**Evidence:**
<what was actually found — quote relevant code, output, or file contents>

(repeat for each test)

### Failures

<List only the failures with full detail for analysis>
```

## Phase 4: Failure Analysis

After all agents complete, the **lead agent** reads all results files and performs root cause analysis for each failing test.

### Analysis steps

1. **Identify the gap**: What does the plan say should happen vs. what actually happens?
2. **Locate the code path**: Read the source files in the plan's "Key Source Paths" (see feature reference table below). Trace from entry point to where the behavior diverges.
3. **Classify the root cause**:

| Root Cause | Description | Example |
|-----------|-------------|---------|
| **Missing** | Feature not implemented at all | Plan says "support X" but no code for X exists |
| **Incomplete** | Partially implemented, key parts missing | Handler exists but doesn't handle edge case Y |
| **Incorrect** | Implemented but does the wrong thing | Logic error, wrong data flow, bad assumption |
| **Integration gap** | Parts work independently but don't connect | Provider exists but isn't wired into the host |
| **Design flaw** | Plan itself has a problem | Contradictory requirements, impossible constraint |

4. **Classify severity**:
   - **Critical**: Core feature is broken, blocks usage
   - **Major**: Feature partially works but has significant gaps
   - **Minor**: Edge case or cosmetic issue

5. **Identify fix location**: Specific file(s) and function(s) that need to change

6. **Note environment**: Which environment(s) the failure occurred in (Local, K8s, or Both). Environment-specific failures may indicate provider implementation gaps rather than feature bugs.

### Key source paths by feature

Use these to quickly find the relevant code when tracing failures:

| Feature Area | Key Source Paths |
|-------------|-----------------|
| Server & HTTP API | `src/host/server.ts`, `src/host/server-completions.ts`, `src/host/server-http.ts` |
| IPC & Schemas | `src/ipc-schemas.ts`, `src/host/ipc-server.ts`, `src/host/ipc-handlers/` |
| Router & Message Flow | `src/host/router.ts` |
| Agent Process | `src/agent/runner.ts`, `src/agent/ipc-client.ts`, `src/agent/tool-catalog.ts` |
| Agent Runners | `src/agent/runners/pi-session.ts`, `src/agent/runners/claude-code.ts` |
| Prompt System | `src/agent/prompt/builder.ts`, `src/agent/prompt/modules/` |
| Skills | `src/providers/skills/git.ts`, `src/providers/skills/readonly.ts`, `src/host/ipc-handlers/skills.ts` |
| Memory | `src/providers/memory/file.ts`, `src/providers/memory/sqlite.ts`, `src/providers/memory/memu.ts` |
| LLM Providers | `src/providers/llm/anthropic.ts`, `src/providers/llm/openai.ts`, `src/providers/llm/router.ts` |
| Sandbox | `src/providers/sandbox/seatbelt.ts`, `src/providers/sandbox/bwrap.ts`, `src/providers/sandbox/subprocess.ts`, `src/providers/sandbox/k8s-pod.ts` |
| Channels | `src/providers/channel/cli.ts`, `src/providers/channel/slack.ts` |
| Security | `src/host/taint-budget.ts`, `src/utils/safe-path.ts`, `src/host/provider-map.ts` |
| Credentials | `src/providers/credentials/plaintext.ts`, `src/providers/credentials/keychain.ts` |
| Scheduler | `src/providers/scheduler/cron.ts`, `src/providers/scheduler/plainjob.ts` |
| Audit | `src/providers/audit/file.ts`, `src/providers/audit/sqlite.ts` |
| Orchestration | `src/host/orchestration/` |
| Config | `src/config.ts`, `src/paths.ts` |
| CLI | `src/cli/index.ts`, `src/cli/chat.ts`, `src/cli/send.ts` |
| Conversation Store | `src/host/conversation-store.ts` |
| File Store | `src/host/file-store.ts` |
| Onboarding | `src/onboarding/`, `src/cli/bootstrap.ts` |
| Plugins | `src/host/plugin-host.ts` |
| Screener | `src/providers/screener/static.ts` |
| Storage | `src/providers/storage/sqlite.ts`, `src/providers/storage/postgresql.ts`, `src/providers/storage/types.ts` |
| EventBus | `src/providers/eventbus/inprocess.ts`, `src/providers/eventbus/nats.ts`, `src/providers/eventbus/types.ts` |
| K8s Sandbox | `src/providers/sandbox/k8s-pod.ts` |
| Pool Controller | `src/pool-controller/main.ts` |
| Agent Runtime | `src/container/agent-runner.ts` |

## Phase 5: Fix List

Create a **single consolidated** fix list from all features and save to `tests/acceptance/fixes.md`. Also create per-feature fix lists at `tests/acceptance/<feature-name>/fixes.md`.

### Per-feature fix list format

```markdown
# Fix List: <Feature Name>

**Generated from:** acceptance test results (<date>)
**Total issues:** <count> (Critical: <n>, Major: <n>, Minor: <n>)

## Critical

### FIX-1: <short description>
**Test:** <test ID that caught this>
**Environment:** <Local / K8s / Both>
**Root cause:** <Missing/Incomplete/Incorrect/Integration gap/Design flaw>
**Location:** `<file>:<function or line range>`
**What's wrong:** <concise description>
**What to fix:** <specific, actionable change>
**Estimated scope:** <number of files to touch>

(repeat for each critical issue)

## Major

(same format)

## Minor

(same format)

## Suggested Fix Order

1. <FIX-ID> — <reason this should go first, e.g., "blocks other fixes" or "most user-visible">
2. <FIX-ID> — <reason>
(continue)
```

### Consolidated fix list format

```markdown
# Consolidated Fix List: All Acceptance Tests

**Date:** <YYYY-MM-DD>
**Features tested:** <list>
**Total issues:** <count> (Critical: <n>, Major: <n>, Minor: <n>)

## Results Summary

| Feature | Local | K8s | Total Issues |
|---------|-------|-----|-------------|
| <feature> | X/Y passed | X/Y passed | <n> |
(repeat for each feature)

## All Fixes by Priority

### Critical
(all critical fixes across all features)

### Major
(all major fixes)

### Minor
(all minor fixes)

## Suggested Fix Order
(cross-feature prioritization)
```

Also add each fix to the **TaskCreate tool** so they're tracked in the current session.

## Workflow Summary

```
SINGLE FEATURE:
  1. User picks a feature
  2. Read the plan document(s)
  3. Extract acceptance criteria
  4. Design test cases (structural first, then behavioral, then integration)
  5. Save test plan to tests/acceptance/<feature>/test-plan.md
  6. Present test plan for user review
  7. Shared k8s setup (build image, load into kind, update helm deps)
  8. Spawn 2 agents in parallel:
     a. Local agent: setup → structural tests → behavioral tests → integration tests → results-local.md → cleanup
     b. K8s agent: setup → behavioral tests → integration tests → results-k8s.md → teardown
  9. Collect results from both agents
  10. Failure analysis: trace to source, classify root cause, severity, and environment
  11. Save fix list to tests/acceptance/<feature>/fixes.md
  12. Add fixes to TaskCreate for tracking

RUN ALL:
  1. Discover all feature directories in tests/acceptance/ (skip fixtures/)
  2. Filter to those with test-plan.md files
  3. Shared k8s setup (build image, load into kind, update helm deps)
  4. Spawn 2*N agents in parallel (one local + one k8s per feature):
     - Each local agent: setup → structural tests → behavioral tests → integration tests → results-local.md → cleanup
     - Each k8s agent: setup → behavioral tests → integration tests → results-k8s.md → teardown
  5. Wait for all agents to complete
  6. Read all results files
  7. Failure analysis across all features
  8. Save per-feature fix lists to tests/acceptance/<feature>/fixes.md
  9. Save consolidated fix list to tests/acceptance/fixes.md
  10. Add fixes to TaskCreate for tracking
```

## Tips

- **Always use an isolated environment.** Local agents create temp directories. K8s agents create unique namespaces. Never run against `~/.ax`.
- **Start with structural tests.** They're fast, deterministic, and catch the most common gaps (missing implementations, broken wiring). If structural tests show a feature isn't wired up, the behavioral tests for that feature will obviously fail — but let them run anyway for completeness.
- **Behavioral/integration tests are sequential within each agent.** They share that agent's server and databases. Parallel execution within a single server causes assertion failures from DB contention.
- **Features run in parallel across agents.** Each feature has its own isolated server, so there's no cross-feature interference.
- **Use fresh sessions.** Each test run should use a unique session ID with 3+ colon-separated segments (e.g., `acceptance:feature:bt1`) to avoid pollution from prior conversations.
- **Check audit logs.** The audit log is the best ground truth for what the server actually did during a request.
- **Don't chase LLM wording.** Focus on: did it call the right tools? Did the right data end up in the right place?
- **Compare environments.** A test that passes locally but fails on k8s likely indicates a provider-level bug (e.g., NATS eventbus doesn't fire the same events as inprocess). A test that fails in both points to a feature-level bug.
- **K8s agents use unique ports.** Each k8s agent picks a random port for port-forwarding to avoid collisions when running in parallel.
- **Shared k8s setup is done once.** The lead agent builds the Docker image and loads it into kind before spawning any k8s agents. Don't rebuild per-feature.
- **K8s uses PostgreSQL for storage.** Conversation history and sessions live in PostgreSQL (in-cluster). Memory (cortex) uses SQLite files on the agent-runtime pod (where the agent process runs). Data in PostgreSQL persists across pod restarts; SQLite data on agent-runtime pods does not (no PVC).
- **Skip k8s if no cluster.** If `kind get clusters` returns nothing, skip all k8s agents and only run local.
