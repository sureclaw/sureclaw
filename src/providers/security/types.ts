// src/providers/security/types.ts — Unified security provider types
//
// Merges ScannerProvider (input/output scanning, canary tokens) with
// SkillScreenerProvider (skill content analysis, permission validation)
// into a single SecurityProvider interface.

import type { TaintTag } from '../../types.js';

// ── Scanner types ───────────────────────────────────────

export interface ScanTarget {
  content: string;
  source: string;
  taint?: TaintTag;
  sessionId: string;
}

export interface ScanResult {
  verdict: 'PASS' | 'FLAG' | 'BLOCK';
  reason?: string;
  patterns?: string[];
}

// ── Screener types ──────────────────────────────────────

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

// ── Unified interface ───────────────────────────────────

export interface SecurityProvider {
  // Scanner methods
  scanInput(msg: ScanTarget): Promise<ScanResult>;
  scanOutput(msg: ScanTarget): Promise<ScanResult>;
  canaryToken(): string;
  checkCanary(output: string, token: string): boolean;

  // Screener methods
  screen(content: string, declaredPermissions?: string[]): Promise<ScreeningVerdict>;
  screenExtended?(content: string, declaredPermissions?: string[]): Promise<ExtendedScreeningVerdict>;
  screenBatch?(items: Array<{ content: string; declaredPermissions?: string[] }>): Promise<ExtendedScreeningVerdict[]>;
}

// ── Backward-compatible aliases ─────────────────────────

/** @deprecated Use SecurityProvider instead. */
export type ScannerProvider = Pick<SecurityProvider, 'scanInput' | 'scanOutput' | 'canaryToken' | 'checkCanary'>;

/** @deprecated Use SecurityProvider instead. */
export type SkillScreenerProvider = Pick<SecurityProvider, 'screen' | 'screenExtended' | 'screenBatch'>;
