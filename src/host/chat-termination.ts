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
 *
 * For sites inside a retry loop (the `agent_response` wait phase), use
 * `createWaitFailureTracker()` instead of calling `logChatTermination`
 * per attempt — it records each attempt's failure cause and emits
 * `chat_terminated` exactly once when retries are truly exhausted, so a
 * chat that fails-then-succeeds doesn't leave a misleading terminal event.
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
 *
 * Optional fields that are `undefined` are omitted from the emitted payload
 * so we never serialise a literal `"undefined"` value into log JSON.
 */
export function logChatTermination(reqLogger: Logger, params: ChatTerminationParams): void {
  const payload: Record<string, unknown> = { phase: params.phase, reason: params.reason };
  if (params.sandboxId !== undefined) payload.sandboxId = params.sandboxId;
  if (params.exitCode !== undefined) payload.exitCode = params.exitCode;
  if (params.details !== undefined) payload.details = params.details;
  reqLogger.error('chat_terminated', payload);
}

/**
 * Parameters for the success-side `chat_complete` event — paired with
 * `chat_terminated` so every chat turn produces exactly one canonical line
 * an operator can scan with `grep "chat_complete\|chat_terminated"`.
 *
 * Only `sessionId` + `durationMs` are required; everything else is
 * best-effort. `phases` (ms per phase: scan / dispatch / agent / persist)
 * lets an operator see at a glance whether a slow chat was slow because
 * the LLM was slow or because storage was slow.
 */
export interface ChatCompleteParams {
  /** Session this chat turn belonged to. */
  sessionId: string;
  /** Resolved agent ID for the turn (when known). */
  agentId?: string;
  /** Total wall-clock time from `processCompletion` entry to the return. */
  durationMs: number;
  /** ms per phase — scan / dispatch / agent / persist. Approximate. */
  phases?: Record<string, number>;
  /** Pod / container name when known, for cross-log correlation. */
  sandboxId?: string;
}

/**
 * Emit the canonical `chat_complete` event at info level.
 *
 * Pass a `reqLogger` that already carries the chat's request-scoped
 * bindings (reqId / sessionId / agentId) so they're attached automatically.
 *
 * Optional fields that are `undefined` are omitted from the emitted payload
 * so we never serialise a literal `"undefined"` value into log JSON
 * (mirrors the `logChatTermination` behaviour for shape consistency).
 */
export function logChatComplete(reqLogger: Logger, params: ChatCompleteParams): void {
  const payload: Record<string, unknown> = {
    sessionId: params.sessionId,
    durationMs: params.durationMs,
  };
  if (params.agentId !== undefined) payload.agentId = params.agentId;
  if (params.phases !== undefined) payload.phases = params.phases;
  if (params.sandboxId !== undefined) payload.sandboxId = params.sandboxId;
  reqLogger.info('chat_complete', payload);
}

export interface WaitFailureRecord {
  reason: string;
  details?: Record<string, unknown>;
}

export interface WaitTerminalContext {
  phase: TerminationPhase;
  reason?: string;
  sandboxId?: string;
  exitCode?: number;
  details?: Record<string, unknown>;
}

export interface WaitFailureTracker {
  record(record: WaitFailureRecord): void;
  emitTerminal(
    reqLogger: Logger,
    terminal: WaitTerminalContext & { reason: string },
  ): void;
}

/**
 * Tracks per-attempt wait-phase failures and emits `chat_terminated` exactly
 * once when retries are exhausted. `record()` is per-attempt and silent;
 * `emitTerminal()` fires the single terminal event. The recorded per-attempt
 * cause wins over the supplied terminal reason — what actually killed the
 * chat (e.g. `agent_response_timeout`) is more specific than the generic
 * fallback (`agent_failed`). A chat that fails-then-succeeds emits zero
 * terminal events because `emitTerminal` is never reached.
 */
export function createWaitFailureTracker(): WaitFailureTracker {
  let lastRecord: WaitFailureRecord | undefined;

  return {
    record(record) {
      lastRecord = record;
    },
    emitTerminal(reqLogger, terminal) {
      const reason = lastRecord?.reason ?? terminal.reason;
      const mergedDetails =
        lastRecord?.details || terminal.details
          ? { ...(lastRecord?.details ?? {}), ...(terminal.details ?? {}) }
          : undefined;
      logChatTermination(reqLogger, {
        phase: terminal.phase,
        reason,
        ...(terminal.sandboxId !== undefined ? { sandboxId: terminal.sandboxId } : {}),
        ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
        ...(mergedDetails !== undefined ? { details: mergedDetails } : {}),
      });
    },
  };
}
