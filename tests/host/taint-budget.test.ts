import { describe, test, expect, beforeEach } from 'vitest';
import { TaintBudget, thresholdForProfile } from '../../src/host/taint-budget.js';

describe('TaintBudget', () => {
  let budget: TaintBudget;

  beforeEach(() => {
    budget = new TaintBudget({ threshold: 0.30 }); // balanced profile
  });

  describe('thresholdForProfile', () => {
    test('returns correct thresholds', () => {
      expect(thresholdForProfile('paranoid')).toBe(0.10);
      expect(thresholdForProfile('balanced')).toBe(0.30);
      expect(thresholdForProfile('yolo')).toBe(0.60);
    });

    test('throws for unknown profile', () => {
      expect(() => thresholdForProfile('invalid' as any)).toThrow('Unknown profile');
    });
  });

  describe('recordContent', () => {
    test('tracks total and tainted tokens', () => {
      budget.recordContent('s1', 'hello world', false); // ~3 tokens
      budget.recordContent('s1', 'external data', true);  // ~4 tokens

      const state = budget.getState('s1');
      expect(state).toBeDefined();
      expect(state!.totalTokens).toBeGreaterThan(0);
      expect(state!.taintedTokens).toBeGreaterThan(0);
      expect(state!.taintedTokens).toBeLessThan(state!.totalTokens);
    });

    test('creates session state on first call', () => {
      expect(budget.getState('new')).toBeUndefined();
      budget.recordContent('new', 'data', false);
      expect(budget.getState('new')).toBeDefined();
    });

    test('tracks sessions independently', () => {
      budget.recordContent('s1', 'clean', false);
      budget.recordContent('s2', 'tainted', true);

      expect(budget.getState('s1')!.taintedTokens).toBe(0);
      expect(budget.getState('s2')!.taintedTokens).toBeGreaterThan(0);
    });
  });

  describe('checkAction', () => {
    test('allows non-sensitive actions regardless of taint', () => {
      budget.recordContent('s1', 'x'.repeat(1000), true); // 100% tainted
      const result = budget.checkAction('s1', 'memory_query');
      expect(result.allowed).toBe(true);
    });

    test('allows sensitive actions when no taint recorded', () => {
      const result = budget.checkAction('s1', 'skill_propose');
      expect(result.allowed).toBe(true);
    });

    test('allows sensitive actions when taint below threshold', () => {
      // 20% tainted, threshold is 30%
      budget.recordContent('s1', 'x'.repeat(800), false);
      budget.recordContent('s1', 'x'.repeat(200), true);

      const result = budget.checkAction('s1', 'skill_propose');
      expect(result.allowed).toBe(true);
    });

    test('blocks sensitive actions when taint exceeds threshold', () => {
      // 80% tainted, threshold is 30%
      budget.recordContent('s1', 'x'.repeat(200), false);
      budget.recordContent('s1', 'x'.repeat(800), true);

      const result = budget.checkAction('s1', 'skill_propose');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('taint ratio');
      expect(result.reason).toContain('skill_propose');
      expect(result.taintRatio).toBeGreaterThan(0.30);
      expect(result.threshold).toBe(0.30);
    });

    test('blocks all default sensitive actions', () => {
      budget.recordContent('s1', 'x'.repeat(100), true); // 100% tainted

      for (const action of ['oauth_call', 'skill_propose', 'browser_navigate', 'scheduler_add_cron', 'identity_propose']) {
        expect(budget.checkAction('s1', action).allowed).toBe(false);
      }
    });

    test('allows with user override', () => {
      budget.recordContent('s1', 'x'.repeat(1000), true); // 100% tainted

      // Should be blocked
      expect(budget.checkAction('s1', 'skill_propose').allowed).toBe(false);

      // Add override
      budget.addUserOverride('s1', 'skill_propose');

      // Now allowed
      expect(budget.checkAction('s1', 'skill_propose').allowed).toBe(true);
    });

    test('override is per-action', () => {
      budget.recordContent('s1', 'x'.repeat(1000), true);

      budget.addUserOverride('s1', 'skill_propose');

      expect(budget.checkAction('s1', 'skill_propose').allowed).toBe(true);
      expect(budget.checkAction('s1', 'oauth_call').allowed).toBe(false);
    });

    test('override is per-session', () => {
      budget.recordContent('s1', 'x'.repeat(1000), true);
      budget.recordContent('s2', 'x'.repeat(1000), true);

      budget.addUserOverride('s1', 'skill_propose');

      expect(budget.checkAction('s1', 'skill_propose').allowed).toBe(true);
      expect(budget.checkAction('s2', 'skill_propose').allowed).toBe(false);
    });
  });

  describe('endSession', () => {
    test('clears session state', () => {
      budget.recordContent('s1', 'data', true);
      expect(budget.getState('s1')).toBeDefined();

      budget.endSession('s1');
      expect(budget.getState('s1')).toBeUndefined();
    });

    test('no-ops for unknown session', () => {
      budget.endSession('nonexistent'); // should not throw
    });
  });

  describe('paranoid threshold (0.10)', () => {
    test('blocks with even small amounts of external content', () => {
      const paranoid = new TaintBudget({ threshold: 0.10 });

      // 15% tainted — blocked in paranoid
      paranoid.recordContent('s1', 'x'.repeat(850), false);
      paranoid.recordContent('s1', 'x'.repeat(150), true);

      expect(paranoid.checkAction('s1', 'skill_propose').allowed).toBe(false);
    });
  });

  describe('yolo threshold (0.60)', () => {
    test('allows moderate taint levels', () => {
      const power = new TaintBudget({ threshold: 0.60 });

      // 50% tainted — allowed in yolo
      power.recordContent('s1', 'x'.repeat(500), false);
      power.recordContent('s1', 'x'.repeat(500), true);

      expect(power.checkAction('s1', 'skill_propose').allowed).toBe(true);
    });

    test('blocks when majority is tainted', () => {
      const power = new TaintBudget({ threshold: 0.60 });

      // 80% tainted — blocked even in yolo
      power.recordContent('s1', 'x'.repeat(200), false);
      power.recordContent('s1', 'x'.repeat(800), true);

      expect(power.checkAction('s1', 'skill_propose').allowed).toBe(false);
    });
  });

  describe('custom sensitive actions', () => {
    test('uses custom set when provided', () => {
      const custom = new TaintBudget({
        threshold: 0.30,
        sensitiveActions: new Set(['my_action']),
      });

      custom.recordContent('s1', 'x'.repeat(1000), true);

      // Default actions should pass
      expect(custom.checkAction('s1', 'skill_propose').allowed).toBe(true);
      // Custom action should block
      expect(custom.checkAction('s1', 'my_action').allowed).toBe(false);
    });
  });
});
