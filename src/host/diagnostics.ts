/**
 * Host-side diagnostic collector — a tiny in-memory ring-buffered bag that
 * captures user-surfacable failure/warning events during a chat turn, so
 * they can be forwarded to the client (SSE in Task B2) and displayed in the
 * chat UI (Task B3).
 *
 * Design notes:
 *   - **Parallel signal, not a log replacement.** Every existing
 *     `logger.warn(...)` stays exactly as it is. Diagnostics are an
 *     *additional* structured record intended for UI display, with a
 *     deliberately human-readable `message` (no stack traces, no
 *     implementation jargon).
 *   - **Ring-buffered at 50 entries.** If a single turn produces more than
 *     50 diagnostics, the oldest entries are dropped and replaced with a
 *     single `{kind: 'diagnostic_overflow'}` marker at the tail, so the UI
 *     can still surface the overflow. 50 is deliberate — if a turn is
 *     emitting more than that, the user is already drowning and we
 *     shouldn't pile on.
 *   - **Immutable list.** `list()` returns a defensive copy (`readonly`
 *     typed) so callers can't mutate the collector's state by reference.
 *   - **Per-session lifecycle.** Future wiring (Task B2) will instantiate
 *     one collector per chat-completion call, emit all collected entries
 *     at end-of-turn, and drop the instance. This file only exports the
 *     type + factory; lifecycle management lives at the call site.
 */

export type DiagnosticSeverity = 'info' | 'warn' | 'error';

export interface Diagnostic {
  /** `info` for FYI, `warn` for "something went sideways but we kept going",
   *  `error` for "something the user needs to know failed". UI rendering can
   *  map these to colors/icons; consumers shouldn't overload semantics. */
  severity: DiagnosticSeverity;
  /** Short, stable identifier for the event. Where possible, matches an
   *  existing host-side log event name (e.g. `catalog_populate_server_failed`)
   *  so log-line greps and UI banners share vocabulary. */
  kind: string;
  /** Human-readable message intended for UI display. NO stack traces, NO
   *  internal identifiers — this is what the user reads. */
  message: string;
  /** Structured context for debugging/display. Keep values primitive so the
   *  UI can render them without serialization surprises. */
  context?: Record<string, string | number | boolean>;
  /** ISO 8601 timestamp (Date#toISOString format). Set by `push`. */
  timestamp: string;
}

export interface DiagnosticCollector {
  /** Append a diagnostic. Timestamp is filled automatically. If the buffer
   *  is already at capacity, the oldest entry is dropped and — on the first
   *  such overflow in the current window — a single overflow marker is
   *  appended at the tail so the UI can surface that diagnostics were
   *  suppressed. */
  push(d: Omit<Diagnostic, 'timestamp'>): void;
  /** Returns a snapshot of the buffered diagnostics in insertion order.
   *  The returned array is a defensive copy — mutations by the caller do
   *  NOT affect the collector's internal state. */
  list(): readonly Diagnostic[];
  /** Clear the buffer. Intended for per-turn lifecycles where one collector
   *  serves multiple sequential turns. */
  reset(): void;
}

/** Maximum number of diagnostics retained in a single collection window.
 *  If more arrive, the oldest are dropped and an overflow marker lands at
 *  the tail. Sized so a turn can surface every reasonable failure while
 *  still capping UI noise on a pathological run. */
const MAX_DIAGNOSTICS = 50;

export function createDiagnosticCollector(): DiagnosticCollector {
  const buf: Diagnostic[] = [];

  const push = (d: Omit<Diagnostic, 'timestamp'>): void => {
    const entry: Diagnostic = { ...d, timestamp: new Date().toISOString() };
    // If the tail is already an overflow marker, we're past capacity.
    // Drop the oldest real entry to make room for the new one, slot it in
    // before the marker, and leave the marker at the tail.
    const tail = buf[buf.length - 1];
    const inOverflow = tail?.kind === 'diagnostic_overflow';
    if (inOverflow) {
      buf.shift();
      buf.splice(buf.length - 1, 0, entry);
      return;
    }
    buf.push(entry);
    if (buf.length > MAX_DIAGNOSTICS) {
      // Crossed the cap with this push. Drop the two oldest real entries
      // and append a marker — buffer now holds (MAX_DIAGNOSTICS - 1) real
      // entries + 1 marker = MAX_DIAGNOSTICS total. The UI sees the most
      // recent (MAX-1) real entries plus an explicit "we suppressed some"
      // signal at the tail.
      buf.shift();
      buf.shift();
      buf.push({
        severity: 'warn',
        kind: 'diagnostic_overflow',
        message: 'Additional diagnostics were suppressed',
        timestamp: new Date().toISOString(),
      });
    }
  };

  const list = (): readonly Diagnostic[] => {
    // Defensive copy: callers shouldn't be able to mutate our buffer by
    // reference. Typing it `readonly` gives compile-time protection; the
    // copy gives runtime protection against `as Diagnostic[]` escapes.
    return buf.slice();
  };

  const reset = (): void => {
    buf.length = 0;
  };

  return { push, list, reset };
}
