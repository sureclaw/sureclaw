// src/providers/audit/types.ts — Audit provider types
import type { TaintTag } from '../../types.js';

export interface AuditEntry {
  timestamp: Date;
  sessionId: string;
  action: string;
  args: Record<string, unknown>;
  result: 'success' | 'blocked' | 'error' | 'fallback' | 'compare_match' | 'compare_mismatch' | 'compare_error';
  taint?: TaintTag;
  durationMs: number;
  tokenUsage?: { input: number; output: number };
}

export interface AuditFilter {
  action?: string;
  sessionId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface AuditProvider {
  log(entry: Partial<AuditEntry>): Promise<void>;
  query(filter: AuditFilter): Promise<AuditEntry[]>;
}
