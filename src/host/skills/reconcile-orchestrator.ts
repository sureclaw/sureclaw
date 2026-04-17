// src/host/skills/reconcile-orchestrator.ts — Glue for the full reconcile
// cycle: snapshot → current-state → reconcile() → persist → emit.
//
// Phase 2 deliberately drops `output.desired` on the floor — MCP registration
// and proxy allowlist wiring land in phase 4. The push-time hook MUST NOT
// 500 the push on a reconcile error; on any throw we log, emit a single
// `skills.reconcile_failed` event, and return zeroed counts.

import type { EventBus } from '../event-bus.js';
import type { CurrentStateDeps } from './current-state.js';
import { buildSnapshotFromBareRepo } from './snapshot.js';
import { loadCurrentState } from './current-state.js';
import { reconcile } from './reconciler.js';
import { getLogger } from '../../logger.js';

export interface OrchestratorDeps extends CurrentStateDeps {
  eventBus: EventBus;
  /** Resolve the bare repo path for an agent. Injected so the orchestrator
   * stays free of path-resolution policy. */
  getBareRepoPath(agentId: string): string;
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
