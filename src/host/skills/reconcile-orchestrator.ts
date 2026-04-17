// src/host/skills/reconcile-orchestrator.ts — Glue for the full reconcile
// cycle: snapshot → current-state → reconcile() → persist → apply live → emit.
//
// Phase 4 wires `output.desired.{mcpServers,proxyAllowlist}` through the
// optional `mcpApplier` / `proxyApplier` deps so live MCP registrations and
// the proxy allowlist track DB state. Appliers are invoked AFTER the DB
// write; their failures warn-log but don't escape — the DB is already
// consistent and the next reconcile (or startup rehydration) catches up.
//
// The push-time hook MUST NOT 500 the push on a reconcile error; on any
// throw we log, emit a single `skills.reconcile_failed` event, and return
// zeroed counts.

import type { EventBus } from '../event-bus.js';
import type { CurrentStateDeps } from './current-state.js';
import { buildSnapshotFromBareRepo } from './snapshot.js';
import { loadCurrentState } from './current-state.js';
import { reconcile } from './reconciler.js';
import { getLogger } from '../../logger.js';
import type { McpApplier, McpApplyResult } from './mcp-applier.js';
import type { ProxyApplier, ProxyApplyResult } from './proxy-applier.js';

export interface OrchestratorDeps extends CurrentStateDeps {
  eventBus: EventBus;
  /** Resolve the bare repo path for an agent. Injected so the orchestrator
   * stays free of path-resolution policy. */
  getBareRepoPath(agentId: string): string;
  /** Phase 4: live MCP registration. Optional for back-compat with phase-2 tests. */
  mcpApplier?: McpApplier;
  /** Phase 4: live proxy-allowlist updates. Optional for back-compat. */
  proxyApplier?: ProxyApplier;
}

export async function reconcileAgent(
  agentId: string,
  ref: string,
  deps: OrchestratorDeps,
): Promise<{ skills: number; events: number }> {
  const log = getLogger().child({ component: 'skills-reconcile' });

  try {
    const bareRepoPath = deps.getBareRepoPath(agentId);
    const snapshot = await buildSnapshotFromBareRepo(bareRepoPath, ref);
    const current = await loadCurrentState(agentId, deps);
    const output = reconcile({ snapshot, current });

    // Atomic: both tables change together or neither does. If the second
    // insert failed previously, the DB could end up with fresh skill_states
    // and stale skill_setup_queue, giving the user an inconsistent view
    // until the next reconcile.
    await deps.stateStore.putStatesAndQueue(agentId, output.skills, output.setupQueue);

    // Phase 4: apply reconciler's desired state to live surfaces.
    // Runs AFTER DB write — if applier throws, DB is already consistent and
    // startup rehydration / next reconcile will catch up.
    const applierSummary: { mcp?: McpApplyResult; proxy?: ProxyApplyResult } = {};
    if (deps.mcpApplier) {
      try {
        applierSummary.mcp = await deps.mcpApplier.apply(agentId, output.desired.mcpServers);
      } catch (err) {
        log.warn('mcp_applier_failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (deps.proxyApplier) {
      try {
        applierSummary.proxy = await deps.proxyApplier.apply(agentId, output.desired.proxyAllowlist);
      } catch (err) {
        log.warn('proxy_applier_failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Only emit when at least one applier produced a result. When an applier
    // throws, its summary stays undefined — if both throw, we skip the event
    // so subscribers don't see a success signal for a failed apply.
    if (applierSummary.mcp !== undefined || applierSummary.proxy !== undefined) {
      deps.eventBus.emit({
        type: 'skills.live_state_applied',
        requestId: agentId,
        timestamp: Date.now(),
        data: {
          mcp: applierSummary.mcp,
          proxy: applierSummary.proxy,
        },
      });
    }

    for (const ev of output.events) {
      deps.eventBus.emit({
        type: ev.type,
        requestId: agentId,
        timestamp: Date.now(),
        data: ev.data,
      });
    }

    return { skills: output.skills.length, events: output.events.length };
  } catch (err) {
    // Defensive: non-Error throws (thrown strings, thrown objects) shouldn't
    // blow up the error path. err.message on a non-Error returns undefined
    // and propagates "undefined" into the event.
    const message = err instanceof Error ? err.message : String(err);
    log.error('reconcile_failed', { agentId, ref, error: message });
    deps.eventBus.emit({
      type: 'skills.reconcile_failed',
      requestId: agentId,
      timestamp: Date.now(),
      data: { error: message },
    });
    return { skills: 0, events: 0 };
  }
}
