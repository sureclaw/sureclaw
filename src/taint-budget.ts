/**
 * SC-SEC-003: Taint Budget Enforcement
 *
 * Tracks per-session taint ratio (external content / total content) and
 * blocks sensitive actions when the ratio exceeds the profile threshold.
 */

export interface TaintBudgetConfig {
  threshold: number;
  sensitiveActions?: Set<string>;
}

export interface TaintCheckResult {
  allowed: boolean;
  reason?: string;
  taintRatio?: number;
  threshold?: number;
}

export interface SessionTaintState {
  totalTokens: number;
  taintedTokens: number;
  overrides: Set<string>;
}

const PROFILE_THRESHOLDS: Record<string, number> = {
  paranoid: 0.10,
  standard: 0.30,
  power_user: 0.60,
};

const DEFAULT_SENSITIVE_ACTIONS = new Set([
  'oauth_call',
  'skill_propose',
  'browser_navigate',
  'scheduler_add_cron',
]);

// Rough token estimation: ~4 characters per token
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export function thresholdForProfile(profile: string): number {
  const threshold = PROFILE_THRESHOLDS[profile];
  if (threshold === undefined) {
    throw new Error(`Unknown profile: "${profile}"`);
  }
  return threshold;
}

export class TaintBudget {
  private sessions = new Map<string, SessionTaintState>();
  private threshold: number;
  private sensitiveActions: Set<string>;

  constructor(config: TaintBudgetConfig) {
    this.threshold = config.threshold;
    this.sensitiveActions = config.sensitiveActions ?? DEFAULT_SENSITIVE_ACTIONS;
  }

  recordContent(sessionId: string, content: string, isTainted: boolean): void {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { totalTokens: 0, taintedTokens: 0, overrides: new Set() };
      this.sessions.set(sessionId, state);
    }

    const tokens = estimateTokens(content);
    state.totalTokens += tokens;
    if (isTainted) {
      state.taintedTokens += tokens;
    }
  }

  checkAction(sessionId: string, action: string): TaintCheckResult {
    // Non-sensitive actions are always allowed
    if (!this.sensitiveActions.has(action)) {
      return { allowed: true };
    }

    const state = this.sessions.get(sessionId);

    // No state or zero tokens — allow
    if (!state || state.totalTokens === 0) {
      return { allowed: true };
    }

    // User override for this action — allow
    if (state.overrides.has(action)) {
      return { allowed: true };
    }

    const ratio = state.taintedTokens / state.totalTokens;

    if (ratio > this.threshold) {
      return {
        allowed: false,
        reason:
          `Session taint ratio ${(ratio * 100).toFixed(1)}% exceeds threshold ` +
          `${(this.threshold * 100).toFixed(0)}%. Action "${action}" requires ` +
          `user confirmation.`,
        taintRatio: ratio,
        threshold: this.threshold,
      };
    }

    return { allowed: true };
  }

  addUserOverride(sessionId: string, action: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.overrides.add(action);
    }
  }

  getState(sessionId: string): SessionTaintState | undefined {
    return this.sessions.get(sessionId);
  }

  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
