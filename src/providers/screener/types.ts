// src/providers/screener/types.ts — Skill content screener types

export interface ScreeningVerdict {
  allowed: boolean;
  reasons: string[];
}

export type ScreeningSeverity = 'INFO' | 'FLAG' | 'BLOCK';
export type ScreeningVerdictKind = 'APPROVE' | 'REVIEW' | 'REJECT';

export interface ScreeningReason {
  category: string;
  severity: ScreeningSeverity;
  detail: string;
  line?: number;
}

export interface ExtendedScreeningVerdict {
  verdict: ScreeningVerdictKind;
  score: number;
  reasons: ScreeningReason[];
  permissions: string[];
  excessPermissions: string[];
}

export interface SkillScreenerProvider {
  screen(content: string, declaredPermissions?: string[]): Promise<ScreeningVerdict>;
  screenExtended?(content: string, declaredPermissions?: string[]): Promise<ExtendedScreeningVerdict>;
  screenBatch?(items: Array<{ content: string; declaredPermissions?: string[] }>): Promise<ExtendedScreeningVerdict[]>;
}
