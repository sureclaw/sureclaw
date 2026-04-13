/**
 * Shared scheduler utilities — cron matching, active hours, session helpers.
 */

import type { SessionAddress } from '../shared-types.js';

export interface ActiveHours {
  start: number; // minutes from midnight
  end: number;
  timezone: string;
}

export function schedulerSession(sender: string, agentId?: string): SessionAddress {
  return { provider: 'scheduler', scope: 'dm', identifiers: { ...(agentId ? { workspace: agentId } : {}), peer: sender } };
}

export function parseTime(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

export function isWithinActiveHours(hours: ActiveHours): boolean {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: hours.timezone,
  });
  const currentMinutes = parseTime(timeStr);
  return currentMinutes >= hours.start && currentMinutes < hours.end;
}

/**
 * Parse a single cron field (minute, hour, dom, month, dow).
 * Supports: *, N, N-M, *​/N, N-M/N, comma-separated lists.
 */
export function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let lo = min, hi = max;
    if (range !== '*') {
      if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number);
        lo = a; hi = b;
      } else {
        lo = hi = parseInt(range, 10);
      }
    }
    for (let v = lo; v <= hi; v += step) result.add(v);
  }
  return result;
}

/**
 * Check if the given Date matches a standard 5-field cron expression.
 * Fields: minute hour day-of-month month day-of-week
 */
/** Returns a key like "2026-02-21T19:07" identifying the current minute. */
export function minuteKey(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

export function matchesCron(schedule: string, date: Date): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monthF, dowF] = fields;
  return (
    parseCronField(minF, 0, 59).has(date.getMinutes()) &&
    parseCronField(hourF, 0, 23).has(date.getHours()) &&
    parseCronField(domF, 1, 31).has(date.getDate()) &&
    parseCronField(monthF, 1, 12).has(date.getMonth() + 1) &&
    parseCronField(dowF, 0, 6).has(date.getDay())
  );
}
