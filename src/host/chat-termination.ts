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
 * Per-attempt failure record kept by the tracker. The retry loop calls
 * `record()` each time an attempt fails so the tracker can report the
 * most recent cause when the chat is finally declared terminated.
 */
export interface WaitFailureRecord {
  /** Stable cause identifier — `agent_response_timeout`, `agent_response_error`, etc. */
  reason: string;
  /** Per-attempt context (error message, exit code, etc.) — merged into the terminal event. */
  details?: Record<string, unknown>;
}

/**
 * Terminal context the caller layers on at the truly-terminated point —
 * adds chat-level info (sandboxId, exitCode, attempt count) on top of the
 * most recent per-attempt cause. Reason is optional: when omitted the
 * tracker uses the recorded reason; when supplied (e.g. `agent_failed`),
 * the explicit value wins.
 */
export interface WaitTerminalContext {
  phase: TerminationPhase;
  reason?: string;
  sandboxId?: string;
  exitCode?: number;
  details?: Record<string, unknown>;
}

/**
 * Tracks wait-phase failures across retry attempts and emits
 * `chat_terminated` exactly once when the loop truly gives up.
 *
 * Usage in a retry loop:
 * ```
 * const tracker = createWaitFailureTracker();
 * for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
 *   try { await waitForAgent(); break; } catch (err) {
 *     tracker.record({ reason: classify(err), details: { error: err.message } });
 *   }
 *   if (terminalCondition) {
 *     tracker.emit(logger, { phase: 'wait', sandboxId, exitCode });
 *     return failureResponse;
 *   }
 * }
 * ```
 *
 * - `record()` per failed attempt — never logs anything by itself.
 * - `emit()` once at the terminal point — fires `chat_terminated` using
 *   the most recent recorded cause merged with the terminal context.
 *   No-op if no failure was ever recorded.
 * - `emitTerminal()` always fires (use when the terminal point doesn't
 *   come from a recorded wait failure — e.g. agent crashed cleanly).
 */
export interface WaitFailureTracker {
  /** Record a per-attempt failure cause; does not log. */
  record(record: WaitFailureRecord): void;
  /**
   * Fire `chat_terminated` once using the most recently recorded cause
   * merged with the terminal context. No-op if nothing was recorded —
   * use `emitTerminal()` if you want to fire regardless.
   */
  emit(reqLogger: Logger, terminal: WaitTerminalContext): void;
  /**
   * Always fire `chat_terminated` with the supplied terminal context,
   * merging in any recorded per-attempt details. The terminal `reason`
   * is required here (no recorded cause to fall back to).
   */
  emitTerminal(
    reqLogger: Logger,
    terminal: WaitTerminalContext & { reason: string },
  ): void;
}

export function createWaitFailureTracker(): WaitFailureTracker {
  let lastRecord: WaitFailureRecord | undefined;

  function emitWith(reqLogger: Logger, params: ChatTerminationParams): void {
    logChatTermination(reqLogger, params);
  }

  return {
    record(record) {
      lastRecord = record;
    },
    emit(reqLogger, terminal) {
      if (!lastRecord && !terminal.reason) {
        // Nothing went wrong (or nothing recorded) and the caller didn't
        // override with an explicit terminal reason — stay silent.
        return;
      }
      const reason = terminal.reason ?? lastRecord!.reason;
      const mergedDetails =
        lastRecord?.details || terminal.details
          ? { ...(lastRecord?.details ?? {}), ...(terminal.details ?? {}) }
          : undefined;
      emitWith(reqLogger, {
        phase: terminal.phase,
        reason,
        ...(terminal.sandboxId !== undefined ? { sandboxId: terminal.sandboxId } : {}),
        ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
        ...(mergedDetails !== undefined ? { details: mergedDetails } : {}),
      });
    },
    emitTerminal(reqLogger, terminal) {
      // The recorded per-attempt cause (when present) is the more specific
      // truth — it names what actually killed the chat (timeout vs response
      // error). Fall back to the terminal reason when nothing was recorded
      // (e.g. agent crashed cleanly with non-zero exit and never errored on
      // the response promise).
      const reason = lastRecord?.reason ?? terminal.reason;
      const mergedDetails =
        lastRecord?.details || terminal.details
          ? { ...(lastRecord?.details ?? {}), ...(terminal.details ?? {}) }
          : undefined;
      emitWith(reqLogger, {
        phase: terminal.phase,
        reason,
        ...(terminal.sandboxId !== undefined ? { sandboxId: terminal.sandboxId } : {}),
        ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
        ...(mergedDetails !== undefined ? { details: mergedDetails } : {}),
      });
    },
  };
}
