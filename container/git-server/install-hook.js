// AX skills reconciliation post-receive hook installer (container side).
//
// This file MUST stay byte-for-byte identical in its output to
// src/providers/workspace/install-hook.ts. Two code paths, same hook —
// both produce hooks that talk to /v1/internal/skills/reconcile with the
// same HMAC format.
//
// Why duplicated? The git-http container does not share source with the
// host. Rather than bundling TypeScript into the container, we inline the
// (~30 line) template in plain JS and test both sides produce the same
// bytes.
//
// Editing this file? Mirror the change in src/providers/workspace/install-hook.ts
// or the tests will fail.

const fs = require('fs');
const path = require('path');

// Busybox-compat HMAC hex encoding:
//   openssl ... -binary | od -An -tx1 | tr -d ' \n'
// Alpine's busybox ships with `od` but not always `xxd`. `od -An -tx1`
// prints bytes as space-separated hex; `tr -d ' \n'` squashes them.
const TEMPLATE = `#!/bin/sh
# AX skills reconciliation hook — installed by the host.
# Kept in sync with container/git-server/install-hook.js.
set -eu

AGENT_ID="__AGENT_ID__"

HOST_URL="\${AX_HOST_URL:-http://localhost:8080}"

# Secret must be provided at runtime; if missing, the hook is a no-op so pushes don't fail.
if [ -z "\${AX_HOOK_SECRET:-}" ]; then
  exit 0
fi

while read -r oldSha newSha ref; do
  # Only reconcile refs/heads/main — cheap filter to avoid churn on tags/PR refs.
  case "\$ref" in
    refs/heads/main) ;;
    *) continue ;;
  esac

  # Skip branch deletions. 'git push --delete main' sends newSha=all-zeros;
  # there's nothing at that SHA to read the manifest from, so reconcile
  # would just emit skills.reconcile_failed and leave prior skills stuck.
  # The next push that recreates main will trigger a fresh reconcile.
  case "\$newSha" in
    0000000000000000000000000000000000000000) continue ;;
  esac

  body=\$(printf '{"agentId":"%s","ref":"%s","oldSha":"%s","newSha":"%s"}' \\
    "\$AGENT_ID" "\$ref" "\$oldSha" "\$newSha")

  # Compute HMAC-SHA256 hex using openssl + busybox-compatible od.
  sig="sha256=\$(printf '%s' "\$body" | openssl dgst -sha256 -hmac "\$AX_HOOK_SECRET" -binary | od -An -tx1 | tr -d ' \\n')"

  # Best-effort. Failure of the hook MUST NOT block the push.
  # --data-binary (not -d) preserves exact body bytes. curl -d strips CR/LF
  # and can mangle binary input; the HMAC covers exact bytes so we must too.
  curl -fsS -m 10 \\
    -H "Content-Type: application/json" \\
    -H "X-AX-Hook-Signature: \$sig" \\
    --data-binary "\$body" \\
    "\$HOST_URL/v1/internal/skills/reconcile" >/dev/null 2>&1 || true
done
`;

/**
 * Install the AX post-receive hook into a bare git repository.
 *
 * Idempotent: overwrites any existing hook at the same path.
 *
 * @param {string} repoPath - Path to the bare repo (must already exist with hooks/).
 * @param {string} agentId - Agent ID to substitute into the hook (also the repo name).
 */
function installPostReceiveHook(repoPath, agentId) {
  const hookPath = path.join(repoPath, 'hooks', 'post-receive');
  const content = TEMPLATE.replaceAll('__AGENT_ID__', agentId);
  fs.writeFileSync(hookPath, content, { mode: 0o755 });
  // Explicit chmod: writeFileSync's `mode` is honored on create but is a
  // no-op when the file already exists on some filesystems.
  fs.chmodSync(hookPath, 0o755);
}

module.exports = { installPostReceiveHook, TEMPLATE };
