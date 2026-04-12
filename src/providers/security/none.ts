/**
 * No-op security provider — always passes/approves. For testing and trusted environments.
 */

import { randomBytes } from 'node:crypto';
import type { Config } from '../../types.js';
import type {
  SecurityProvider,
  ScanResult,
  ScreeningVerdict,
  ExtendedScreeningVerdict,
} from './types.js';

export function create(_config: Config): SecurityProvider {
  return {
    // Scanner methods
    async scanInput(): Promise<ScanResult> {
      return { verdict: 'PASS' };
    },
    async scanOutput(): Promise<ScanResult> {
      return { verdict: 'PASS' };
    },
    canaryToken(): string {
      return `CANARY-${randomBytes(16).toString('hex')}`;
    },
    checkCanary(output: string, token: string): boolean {
      return output.includes(token);
    },

    // Screener methods
    async screen(): Promise<ScreeningVerdict> {
      return { allowed: true, reasons: [] };
    },
    async screenExtended(): Promise<ExtendedScreeningVerdict> {
      return { verdict: 'APPROVE', score: 0, reasons: [], permissions: [], excessPermissions: [] };
    },
    async screenBatch(items: Array<{ content: string; declaredPermissions?: string[] }>): Promise<ExtendedScreeningVerdict[]> {
      return items.map(() => ({ verdict: 'APPROVE' as const, score: 0, reasons: [], permissions: [], excessPermissions: [] }));
    },
  };
}
