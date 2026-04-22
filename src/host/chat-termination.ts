/**
 * Unified "this chat ended badly" logger.
 *
 * Every host-side site where a chat turn dies abnormally (sandbox spawn
 * failed, fast-path crashed, agent_response timed out or errored, pod
 * disappeared mid-turn, cleanup blew up) calls `logChatTermination` with a
 * structured `phase` + `reason`. The result is a single greppable event —
 * `chat_terminated` — at error level (so `level >= 40` filters cleanly to
 * "things that killed chats"). Operators can `kubectl logs ax-host | grep
 * chat_terminated` to see every chat-killing event with its cause, and
 * `grep <reqId>` to drill into one chat across all the lines that led up
 * to it (sandbox lifecycle, pod_failed, etc.).
 *
 * The helper itself is intentionally trivial — the value is consistency,
 * not cleverness. Each caller site supplies a `reqLogger` (a child logger
 * already bound to `reqId` / `sessionId` / `agentId`), so those fields ride
 * along automatically without callers having to remember to pass them.
 */

import type { Logger } from '../logger.js';

/**
 * Where in the chat lifecycle the failure occurred. Keep this set small
 * and stable — operators will alert on these values.
 *
 * - `spawn`    — failed to start the sandbox / agent process
 * - `dispatch` — failed during host-side fast-path / routing before the
 *                agent ran
 * - `sandbox`  — the sandbox died on its own (OOM, evicted, timeout)
 * - `wait`     — host was waiting for the agent's response and gave up
 *                (timeout, IPC error, downstream of a sandbox death)
 * - `cleanup`  — failure during post-turn teardown
 */
export type TerminationPhase = 'spawn' | 'dispatch' | 'sandbox' | 'wait' | 'cleanup';

export interface ChatTerminationParams {
  /** Lifecycle phase the chat died in. */
  phase: TerminationPhase;
  /** Short, stable identifier for the cause — used for grouping/alerts. */
  reason: string;
  /** Pod name / container name when known, for cross-log correlation. */
  sandboxId?: string;
  /** Process exit code when known. */
  exitCode?: number;
  /** Free-form context (truncated stderr, error message, timeoutMs, etc.). */
  details?: Record<string, unknown>;
}

/**
 * Emit the canonical `chat_terminated` event at error level.
 *
 * Pass a `reqLogger` that already carries the chat's request-scoped
 * bindings (reqId / sessionId / agentId) so they're automatically attached
 * to the event by the underlying logger.
 */
export function logChatTermination(reqLogger: Logger, params: ChatTerminationParams): void {
  reqLogger.error('chat_terminated', { ...params });
}
