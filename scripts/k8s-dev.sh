#!/usr/bin/env bash
set -euo pipefail

# k8s-dev.sh — Fast iteration dev loop for AX in a local kind cluster.
# Usage: scripts/k8s-dev.sh <command> [args]

CLUSTER_NAME="ax-dev"
NAMESPACE="ax-dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[k8s-dev]${NC} $*"; }
warn() { echo -e "${YELLOW}[k8s-dev]${NC} $*"; }
err()  { echo -e "${RED}[k8s-dev]${NC} $*" >&2; }

# ─── Prerequisites ──────────────────────────────────────────────
check_prereqs() {
  local missing=()
  for cmd in kind helm kubectl docker; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required tools: ${missing[*]}"
    err "Install with: brew install ${missing[*]}"
    exit 1
  fi
  if ! docker info &>/dev/null; then
    err "Docker is not running. Start Docker Desktop first."
    exit 1
  fi
}

# ─── Setup ──────────────────────────────────────────────────────
cmd_setup() {
  check_prereqs
  log "Setting up kind cluster '$CLUSTER_NAME' with host volume mounts..."

  # Generate kind config with current directory
  local kind_config
  kind_config=$(mktemp)
  cat > "$kind_config" <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: ${PROJECT_ROOT}/dist
        containerPath: /ax-dev/dist
      - hostPath: ${PROJECT_ROOT}/templates
        containerPath: /ax-dev/templates
      - hostPath: ${PROJECT_ROOT}/skills
        containerPath: /ax-dev/skills
  - role: worker
    extraMounts:
      - hostPath: ${PROJECT_ROOT}/dist
        containerPath: /ax-dev/dist
      - hostPath: ${PROJECT_ROOT}/templates
        containerPath: /ax-dev/templates
      - hostPath: ${PROJECT_ROOT}/skills
        containerPath: /ax-dev/skills
EOF

  # Create cluster
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    warn "Cluster '$CLUSTER_NAME' already exists. Use 'teardown' first to recreate."
  else
    kind create cluster --name "$CLUSTER_NAME" --config "$kind_config"
  fi
  rm -f "$kind_config"

  # Build
  log "Building TypeScript..."
  (cd "$PROJECT_ROOT" && npm run build)

  # Docker build + load
  log "Building Docker image..."
  (cd "$PROJECT_ROOT" && docker build -t ax:latest -f container/agent/Dockerfile .)
  log "Loading image into kind..."
  kind load docker-image ax:latest --name "$CLUSTER_NAME"

  # Namespace + secrets
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

  # Database credentials (internal PostgreSQL)
  kubectl -n "$NAMESPACE" create secret generic ax-db-credentials \
    --from-literal=url="postgresql://ax:ax-dev-password@ax-postgresql:5432/ax" \
    --dry-run=client -o yaml | kubectl apply -f -

  # API credentials
  local api_secret_args=()
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && api_secret_args+=(--from-literal=anthropic-api-key="$ANTHROPIC_API_KEY")
  [[ -n "${OPENAI_API_KEY:-}" ]] && api_secret_args+=(--from-literal=openai-api-key="$OPENAI_API_KEY")
  [[ -n "${OPENROUTER_API_KEY:-}" ]] && api_secret_args+=(--from-literal=openrouter-api-key="$OPENROUTER_API_KEY")

  if [[ ${#api_secret_args[@]} -gt 0 ]]; then
    kubectl -n "$NAMESPACE" create secret generic ax-api-credentials \
      "${api_secret_args[@]}" \
      --dry-run=client -o yaml | kubectl apply -f -
  else
    warn "No API keys found in env (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY)"
    warn "Set them and re-run setup, or create the secret manually."
  fi

  # Helm
  log "Updating Helm dependencies..."
  (cd "$PROJECT_ROOT" && helm dependency update charts/ax)

  log "Installing AX via Helm..."
  helm upgrade --install ax charts/ax \
    -n "$NAMESPACE" \
    -f charts/ax/kind-dev-values.yaml \
    --wait --timeout 5m

  log "Waiting for pods to be ready..."
  kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app.kubernetes.io/name=ax-host --timeout=120s 2>/dev/null || true
  kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app.kubernetes.io/name=ax-pool-controller --timeout=120s 2>/dev/null || true

  echo ""
  log "Setup complete! Cluster '$CLUSTER_NAME' is ready."
  cmd_status
  echo ""
  log "Quick start:"
  log "  npm run k8s:dev cycle         # build + flush sandbox pods"
  log "  npm run k8s:dev test 'hello'  # send a test message"
  log "  npm run k8s:dev logs sandbox  # tail sandbox logs"
}

# ─── Build ──────────────────────────────────────────────────────
cmd_build() {
  log "Building TypeScript..."
  (cd "$PROJECT_ROOT" && npm run build)
  log "Build complete. Changes are on the host filesystem."
}

# ─── Flush ──────────────────────────────────────────────────────
cmd_flush() {
  local target="${1:-sandbox}"

  if [[ "$target" == "all" ]]; then
    # Restart node process in host pods (kill PID 1 → container restarts)
    log "Restarting host process..."
    for pod in $(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=host -o name 2>/dev/null); do
      kubectl -n "$NAMESPACE" exec "$pod" -- kill 1 2>/dev/null || true
    done

    # Restart pool controller process
    log "Restarting pool controller process..."
    for pod in $(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=pool-controller -o name 2>/dev/null); do
      kubectl -n "$NAMESPACE" exec "$pod" -- kill 1 2>/dev/null || true
    done

    # Wait for host to come back
    sleep 2
    kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app.kubernetes.io/component=host --timeout=30s 2>/dev/null || true
  fi

  # Delete sandbox pods — pool controller recreates them
  local count
  count=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=ax-sandbox --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    log "Flushing $count sandbox pod(s)..."
    kubectl -n "$NAMESPACE" delete pods -l app.kubernetes.io/name=ax-sandbox --grace-period=5
  else
    log "No sandbox pods to flush."
  fi

  log "Waiting for new sandbox pods..."
  sleep 3
  local ready
  ready=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=ax-sandbox --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
  log "Sandbox pods ready: $ready"
}

# ─── Cycle ──────────────────────────────────────────────────────
cmd_cycle() {
  local target="${1:-sandbox}"
  cmd_build
  cmd_flush "$target"
}

# ─── Test ───────────────────────────────────────────────────────
cmd_test() {
  local message="${1:-hello}"

  # Port-forward in background
  local port=18080
  kubectl -n "$NAMESPACE" port-forward svc/ax-host "$port:8080" &>/dev/null &
  local pf_pid=$!
  sleep 1

  log "Sending: $message"
  local response
  response=$(curl -sS -X POST "http://localhost:${port}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"default\",\"messages\":[{\"role\":\"user\",\"content\":$(echo "$message" | jq -Rs .)}]}" \
    2>&1) || true

  kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true

  echo "$response" | jq . 2>/dev/null || echo "$response"
}

# ─── Logs ───────────────────────────────────────────────────────
cmd_logs() {
  local component="${1:-all}"

  case "$component" in
    host)
      kubectl -n "$NAMESPACE" logs -l app.kubernetes.io/component=host -f --tail=100
      ;;
    sandbox)
      kubectl -n "$NAMESPACE" logs -l app.kubernetes.io/name=ax-sandbox -f --tail=100 --max-log-requests=10
      ;;
    pool|pool-controller)
      kubectl -n "$NAMESPACE" logs -l app.kubernetes.io/component=pool-controller -f --tail=100
      ;;
    all)
      kubectl -n "$NAMESPACE" logs -l app.kubernetes.io/part-of=ax -f --tail=50 --max-log-requests=20 --prefix
      ;;
    *)
      err "Unknown component: $component (use: host, sandbox, pool-controller, all)"
      exit 1
      ;;
  esac
}

# ─── Status ─────────────────────────────────────────────────────
cmd_status() {
  echo -e "${CYAN}=== Pod Status ===${NC}"
  kubectl -n "$NAMESPACE" get pods -o wide 2>/dev/null || warn "No pods found"

  echo ""
  echo -e "${CYAN}=== Warm Pool ===${NC}"
  local warm
  warm=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=ax-sandbox,ax.io/status=warm --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
  local pending
  pending=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=ax-sandbox --field-selector=status.phase=Pending --no-headers 2>/dev/null | wc -l | tr -d ' ')
  echo "  Warm (Running): $warm"
  echo "  Pending: $pending"
}

# ─── Debug ──────────────────────────────────────────────────────
cmd_debug() {
  local target="${1:-}"

  case "$target" in
    host)
      log "Port-forwarding host debug port (9229)..."
      log "Attach Chrome DevTools: chrome://inspect or VS Code debugger"
      local pod
      pod=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=host -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
      if [[ -z "$pod" ]]; then
        err "No host pod found"
        exit 1
      fi
      kubectl -n "$NAMESPACE" port-forward "$pod" 9229:9229
      ;;
    sandbox)
      log "Setting debug flag for next sandbox pod..."

      # Patch the sandbox template to add --inspect-brk
      # We do this by updating the Helm release with a debug command override
      helm upgrade ax charts/ax \
        -n "$NAMESPACE" \
        -f charts/ax/kind-dev-values.yaml \
        --set 'sandbox.tiers.light.template.command={node,--inspect-brk=0.0.0.0:9230,/ax-dev/dist/agent/runner.js}' \
        --wait --timeout 2m

      # Flush sandbox pods so new ones pick up the debug command
      cmd_flush sandbox

      # Wait for a sandbox pod and port-forward
      log "Waiting for sandbox pod with debugger..."
      kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app.kubernetes.io/name=ax-sandbox --timeout=60s 2>/dev/null || true

      local pod
      pod=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=ax-sandbox --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
      if [[ -z "$pod" ]]; then
        err "No running sandbox pod found"
        exit 1
      fi

      log "Port-forwarding sandbox debug port (9230) from pod $pod..."
      log "Attach Chrome DevTools: chrome://inspect or VS Code debugger"
      log "Then run: npm run k8s:dev test 'your message'"
      log "Press Ctrl+C to stop debugging and restore normal sandbox command."
      kubectl -n "$NAMESPACE" port-forward "$pod" 9230:9230 || true

      # Restore normal command
      log "Restoring normal sandbox command..."
      helm upgrade ax charts/ax \
        -n "$NAMESPACE" \
        -f charts/ax/kind-dev-values.yaml \
        --wait --timeout 2m
      cmd_flush sandbox
      ;;
    *)
      err "Usage: k8s-dev debug <host|sandbox>"
      exit 1
      ;;
  esac
}

# ─── Database ───────────────────────────────────────────────────
cmd_db() {
  local query="${1:-}"

  # Find PostgreSQL pod
  local pg_pod
  pg_pod=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  if [[ -z "$pg_pod" ]]; then
    # Try bitnami naming
    pg_pod=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=primary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  fi

  if [[ -z "$pg_pod" ]]; then
    err "No PostgreSQL pod found in namespace $NAMESPACE"
    exit 1
  fi

  if [[ "$query" == "reset" ]]; then
    log "Resetting database..."
    kubectl -n "$NAMESPACE" exec "$pg_pod" -- \
      env PGPASSWORD=ax-dev-password psql -U ax -d postgres -c "DROP DATABASE IF EXISTS ax;"
    kubectl -n "$NAMESPACE" exec "$pg_pod" -- \
      env PGPASSWORD=ax-dev-password psql -U ax -d postgres -c "CREATE DATABASE ax;"
    log "Database reset. Run 'flush all' to restart pods with fresh DB."
  elif [[ -n "$query" ]]; then
    kubectl -n "$NAMESPACE" exec "$pg_pod" -- \
      env PGPASSWORD=ax-dev-password psql -U ax -d ax -c "$query"
  else
    # Interactive psql via port-forward
    local port=15432
    log "Port-forwarding PostgreSQL to localhost:$port..."
    kubectl -n "$NAMESPACE" port-forward "$pg_pod" "$port:5432" &>/dev/null &
    local pf_pid=$!
    sleep 1

    log "Connecting to PostgreSQL (Ctrl+D to exit)..."
    PGPASSWORD=ax-dev-password psql -h localhost -p "$port" -U ax -d ax || true

    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
  fi
}

# ─── Teardown ───────────────────────────────────────────────────
cmd_teardown() {
  log "Deleting kind cluster '$CLUSTER_NAME'..."
  kind delete cluster --name "$CLUSTER_NAME"
  log "Cluster deleted."
}

# ─── Main ───────────────────────────────────────────────────────
cmd="${1:-help}"
shift || true

case "$cmd" in
  setup)     cmd_setup "$@" ;;
  build)     cmd_build "$@" ;;
  flush)     cmd_flush "$@" ;;
  cycle)     cmd_cycle "$@" ;;
  test)      cmd_test "$@" ;;
  logs)      cmd_logs "$@" ;;
  status)    cmd_status "$@" ;;
  debug)     cmd_debug "$@" ;;
  db)        cmd_db "$@" ;;
  teardown)  cmd_teardown "$@" ;;
  help|--help|-h)
    echo "Usage: scripts/k8s-dev.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  setup              Create kind cluster with host mounts + install AX"
    echo "  build              TypeScript build (tsc)"
    echo "  flush [all]        Flush sandbox pods (or all pods)"
    echo "  cycle [all]        Build + flush"
    echo "  test '<message>'   Send a chat completion request"
    echo "  logs [component]   Tail logs (host|sandbox|pool-controller|all)"
    echo "  status             Show pod status and warm pool count"
    echo "  debug <target>     Attach debugger (host|sandbox)"
    echo "  db [query|reset]   PostgreSQL access (interactive, query, or reset)"
    echo "  teardown           Delete the kind cluster"
    ;;
  *)
    err "Unknown command: $cmd"
    err "Run 'scripts/k8s-dev.sh help' for usage."
    exit 1
    ;;
esac
