// src/host/result-persistence.ts
/**
 * Persists large tool results to /tmp, replacing them with short previews
 * in the LLM context. The agent can read_file the full result on demand.
 *
 * Two-layer defense:
 * 1. Per-result: results exceeding thresholdBytes -> disk + preview
 * 2. Per-turn aggregate: total bytes across all results -> spill largest
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'result-persistence' });

const DEFAULT_THRESHOLD_BYTES = 100_000;   // 100KB per result
const DEFAULT_TURN_BUDGET_BYTES = 200_000; // 200KB aggregate per turn
const DEFAULT_PREVIEW_CHARS = 1_500;       // inline preview size
const DEFAULT_DIR = '/tmp/ax-results';

export interface ResultPersistenceOptions {
  dir?: string;
  thresholdBytes?: number;
  turnBudgetBytes?: number;
  previewChars?: number;
}

export class ResultPersistence {
  private readonly dir: string;
  private readonly threshold: number;
  private readonly turnBudget: number;
  private readonly previewChars: number;
  private turnTotal = 0;

  constructor(opts?: ResultPersistenceOptions) {
    this.dir = opts?.dir ?? DEFAULT_DIR;
    this.threshold = opts?.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
    this.turnBudget = opts?.turnBudgetBytes ?? DEFAULT_TURN_BUDGET_BYTES;
    this.previewChars = opts?.previewChars ?? DEFAULT_PREVIEW_CHARS;
  }

  /**
   * Check if result should be spilled. Returns the original content or a
   * preview stub with a file path.
   */
  maybeSpill(id: string, content: string): string {
    const bytes = Buffer.byteLength(content);

    // Layer 1: per-result threshold
    if (bytes > this.threshold) {
      return this.spill(id, content);
    }

    // Layer 2: per-turn aggregate
    this.turnTotal += bytes;
    if (this.turnTotal > this.turnBudget) {
      return this.spill(id, content);
    }

    return content;
  }

  /** Reset per-turn accumulator (call at start of each agent turn). */
  resetTurn(): void {
    this.turnTotal = 0;
  }

  private spill(id: string, content: string): string {
    try {
      mkdirSync(this.dir, { recursive: true });
      const filePath = join(this.dir, `${id}.json`);
      writeFileSync(filePath, content, 'utf-8');
      logger.debug('result_spilled', { id, bytes: Buffer.byteLength(content), path: filePath });
      return this.buildPreview(content, filePath);
    } catch (err) {
      logger.warn('spill_failed', { id, error: (err as Error).message });
      // If spill fails, truncate inline rather than losing data
      return content.slice(0, this.previewChars) + `\n\n... [truncated, ${content.length} chars total]`;
    }
  }

  private buildPreview(content: string, filePath: string): string {
    const headSize = Math.floor(this.previewChars * 0.6);
    const tailSize = this.previewChars - headSize;
    const head = content.slice(0, headSize);
    const tail = content.slice(-tailSize);
    const omitted = content.length - headSize - tailSize;

    return (
      head +
      `\n\n... [${omitted.toLocaleString()} chars omitted] ...\n\n` +
      tail +
      `\n\n[Full output persisted to ${filePath} — use read_file to access. ID: ${filePath.split('/').pop()}]`
    );
  }
}
