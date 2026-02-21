import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const STATE_FILE = 'heartbeat-state.json';

export class HeartbeatState {
  private data: Record<string, number> = {};
  private filePath: string;

  constructor(dir: string) {
    this.filePath = join(dir, STATE_FILE);
    try {
      this.data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch { /* first run or corrupt — start fresh */ }
  }

  lastRun(checkName: string): number | null {
    return this.data[checkName] ?? null;
  }

  markRun(checkName: string, timestamp: number = Date.now()): void {
    this.data[checkName] = timestamp;
    this.persist();
  }

  isOverdue(checkName: string, cadenceMinutes: number): boolean {
    const last = this.data[checkName];
    if (last == null) return true;
    return (Date.now() - last) >= cadenceMinutes * 60 * 1000;
  }

  /** Human-readable summary for injection into heartbeat prompt. */
  summarize(cadences: Record<string, number>): string {
    const lines: string[] = [];
    for (const [name, cadenceMin] of Object.entries(cadences)) {
      const last = this.data[name];
      const overdue = this.isOverdue(name, cadenceMin);
      if (!last) {
        lines.push(`- **${name}** (every ${cadenceMin}m): never run — OVERDUE`);
      } else {
        const ago = Math.round((Date.now() - last) / 60_000);
        const status = overdue ? 'OVERDUE' : 'ok';
        lines.push(`- **${name}** (every ${cadenceMin}m): last run ${ago}m ago — ${status}`);
      }
    }
    return lines.join('\n');
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch { /* best-effort persistence */ }
  }
}
