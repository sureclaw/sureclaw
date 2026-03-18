/**
 * No-op skill screener — always approves. For testing and trusted environments.
 */

import type { Config } from '../../types.js';
import type {
  SkillScreenerProvider,
  ScreeningVerdict,
  ExtendedScreeningVerdict,
} from './types.js';

export function create(_config: Config): SkillScreenerProvider {
  return {
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
