/**
 * Heartbeat Liveness Monitor — detects stuck or unresponsive agents.
 *
 * Tracks activity timestamps for all agent handles. Any agent.* event
 * on the EventBus counts as proof of life. When an agent exceeds the
 * configured timeout without activity, the monitor auto-interrupts it
 * through the AgentSupervisor.
 */

import { getLogger } from '../../logger.js';
import type { EventBus } from '../event-bus.js';
import type { AgentSupervisor } from './agent-supervisor.js';
import { TERMINAL_STATES } from './types.js';
import type { HeartbeatMonitorConfig } from './types.js';

const logger = getLogger().child({ component: 'heartbeat-monitor' });

const DEFAULT_TIMEOUT_MS = 120_000;       // 2 minutes
const DEFAULT_CHECK_INTERVAL_MS = 10_000; // 10 seconds

export interface HeartbeatMonitor {
  start(eventBus: EventBus, supervisor: AgentSupervisor): () => void;
  recordActivity(handleId: string): void;
  getLastActivity(handleId: string): number | null;
  isTimedOut(handleId: string): boolean;
  stop(): void;
}

export function createHeartbeatMonitor(config?: HeartbeatMonitorConfig): HeartbeatMonitor {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkIntervalMs = config?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  const lastActivity = new Map<string, number>();
  let checkTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  function recordActivity(handleId: string): void {
    lastActivity.set(handleId, Date.now());
  }

  function getLastActivity(handleId: string): number | null {
    return lastActivity.get(handleId) ?? null;
  }

  function isTimedOut(handleId: string): boolean {
    const last = lastActivity.get(handleId);
    if (last == null) return false;
    return Date.now() - last > timeoutMs;
  }

  function start(eventBus: EventBus, supervisor: AgentSupervisor): () => void {
    // Subscribe to all agent events as proof of life
    unsubscribe = eventBus.subscribe((event) => {
      if (!event.type.startsWith('agent.')) return;
      const handleId = event.data.handleId as string | undefined;
      if (handleId) {
        recordActivity(handleId);
      }
    });

    // Periodic check for timed-out agents
    checkTimer = setInterval(() => {
      for (const [handleId, lastTime] of lastActivity) {
        if (Date.now() - lastTime <= timeoutMs) continue;

        const handle = supervisor.get(handleId);
        if (!handle) {
          lastActivity.delete(handleId);
          continue;
        }

        if (TERMINAL_STATES.has(handle.state)) {
          lastActivity.delete(handleId);
          continue;
        }

        if (handle.state === 'interrupted') continue;

        logger.warn('heartbeat_timeout', {
          handleId,
          agentId: handle.agentId,
          lastActivity: lastTime,
          timeoutMs,
        });

        supervisor.interrupt(handleId, `Heartbeat timeout: no activity for ${timeoutMs}ms`);
      }
    }, checkIntervalMs);
    checkTimer.unref?.();

    return () => stop();
  }

  function stop(): void {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  return { start, recordActivity, getLastActivity, isTimedOut, stop };
}
