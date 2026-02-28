/**
 * Agent Loop — the Ralph Wiggum pattern for AX.
 *
 * Runs an agent repeatedly with fresh context until an external
 * validation check passes or maxIterations is reached. Each iteration:
 *
 *   1. Spawn agent with prompt (fresh context — no accumulated history)
 *   2. Wait for completion
 *   3. Run validation function (tests, linter, custom check)
 *   4. If validation passes → done
 *   5. If validation fails → loop with failure feedback
 *   6. If maxIterations reached → stop with last result
 *
 * The key insight from the Ralph Wiggum pattern: fresh context per
 * iteration prevents noise accumulation from failed attempts. The
 * agent sees only the original prompt + the latest validation failure,
 * never the full history of prior tries.
 *
 * Each iteration is tracked as a separate AgentHandle in the
 * Supervisor, so you get full observability: which iteration is
 * running, what state it's in, and the ability to interrupt mid-loop.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../event-bus.js';
import { getLogger } from '../../logger.js';
import type { AgentHandle, AgentRegistration } from './types.js';
import type { Orchestrator } from './orchestrator.js';

const logger = getLogger().child({ component: 'agent-loop' });

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ValidationResult {
  /** Did the validation pass? */
  passed: boolean;
  /** Human-readable summary of what happened. */
  summary: string;
  /** Detailed output (test output, linter errors, etc.). */
  output?: string;
}

/**
 * Validation function: receives the agent's output from the current
 * iteration and returns whether it passes the check.
 */
export type ValidateFn = (agentOutput: string, iteration: number) => Promise<ValidationResult>;

/**
 * Agent execution function: receives the prompt for this iteration
 * and returns the agent's output. The caller provides this — it's
 * the actual "run the agent" step, which may use processCompletion
 * or any other mechanism.
 */
export type ExecuteFn = (prompt: string, iteration: number, handle: AgentHandle) => Promise<string>;

export interface AgentLoopConfig {
  /** The original task prompt. */
  prompt: string;
  /** Maximum iterations before giving up. Always set this. */
  maxIterations: number;
  /** Validation function — external check that decides pass/fail. */
  validate: ValidateFn;
  /** Agent execution function — runs the agent and returns output. */
  execute: ExecuteFn;
  /** Base registration info for spawned agents. */
  registration: Omit<AgentRegistration, 'activity' | 'metadata'>;
  /**
   * Optional: build the prompt for retry iterations.
   * Receives the original prompt + the validation failure.
   * Default: appends validation output as context.
   */
  buildRetryPrompt?: (originalPrompt: string, validation: ValidationResult, iteration: number) => string;
  /** Called after each iteration with progress info. */
  onProgress?: (progress: LoopProgress) => void;
}

export interface LoopProgress {
  iteration: number;
  maxIterations: number;
  status: 'running' | 'passed' | 'failed' | 'max_iterations' | 'interrupted';
  validation?: ValidationResult;
  handleId: string;
  durationMs: number;
}

export interface LoopResult {
  /** Did the loop complete with a passing validation? */
  passed: boolean;
  /** Total iterations executed. */
  iterations: number;
  /** Final agent output. */
  output: string;
  /** Final validation result. */
  validation: ValidationResult;
  /** All iteration handles (for post-mortem inspection). */
  handles: string[];
  /** Total duration of the loop (ms). */
  totalDurationMs: number;
  /** Why the loop stopped. */
  reason: 'validation_passed' | 'max_iterations' | 'interrupted' | 'execute_error';
}

// ═══════════════════════════════════════════════════════
// Default retry prompt builder
// ═══════════════════════════════════════════════════════

function defaultRetryPrompt(
  originalPrompt: string,
  validation: ValidationResult,
  iteration: number,
): string {
  return `${originalPrompt}

---
PREVIOUS ATTEMPT (iteration ${iteration}) FAILED VALIDATION:
${validation.summary}
${validation.output ? `\nValidation output:\n${validation.output}` : ''}

Please fix the issues above and try again.`;
}

// ═══════════════════════════════════════════════════════
// Agent Loop
// ═══════════════════════════════════════════════════════

/**
 * Run an agent in a Ralph-style loop.
 *
 * The loop respects interrupts: if the current iteration's handle
 * is interrupted via the Supervisor, the loop stops after that
 * iteration completes (or immediately if the agent is canceled).
 */
export async function runAgentLoop(
  orchestrator: Orchestrator,
  config: AgentLoopConfig,
): Promise<LoopResult> {
  const {
    prompt,
    maxIterations,
    validate,
    execute,
    registration,
    buildRetryPrompt = defaultRetryPrompt,
    onProgress,
  } = config;

  const loopId = randomUUID().slice(0, 8);
  const handles: string[] = [];
  const loopStart = Date.now();
  let interrupted = false;

  logger.info('agent_loop_start', {
    loopId,
    maxIterations,
    agentId: registration.agentId,
    promptLength: prompt.length,
  });

  // Emit loop start event
  orchestrator.eventBus.emit({
    type: 'agent.loop.start',
    requestId: registration.sessionId,
    timestamp: Date.now(),
    data: { loopId, maxIterations, agentId: registration.agentId },
  });

  let lastOutput = '';
  let lastValidation: ValidationResult = { passed: false, summary: 'No iterations executed' };
  let currentPrompt = prompt;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (interrupted) break;

    // Register a new handle for this iteration (fresh context)
    const handle = orchestrator.register({
      ...registration,
      activity: `Loop ${loopId} — iteration ${iteration}/${maxIterations}`,
      metadata: {
        loopId,
        iteration,
        maxIterations,
        pattern: 'ralph',
      },
    });
    handles.push(handle.id);

    // Transition to running
    orchestrator.supervisor.transition(handle.id, 'running',
      `Loop iteration ${iteration}/${maxIterations}`);

    logger.debug('agent_loop_iteration', {
      loopId,
      iteration,
      maxIterations,
      handleId: handle.id,
      promptLength: currentPrompt.length,
    });

    // Execute the agent
    let output: string;
    try {
      output = await execute(currentPrompt, iteration, handle);
      lastOutput = output;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn('agent_loop_execute_error', { loopId, iteration, error });
      orchestrator.supervisor.fail(handle.id, error);

      lastValidation = { passed: false, summary: `Execution error: ${error}` };

      onProgress?.({
        iteration,
        maxIterations,
        status: 'failed',
        validation: lastValidation,
        handleId: handle.id,
        durationMs: Date.now() - loopStart,
      });

      // Emit loop end event
      orchestrator.eventBus.emit({
        type: 'agent.loop.end',
        requestId: registration.sessionId,
        timestamp: Date.now(),
        data: {
          loopId, iteration, maxIterations,
          reason: 'execute_error', passed: false,
        },
      });

      return {
        passed: false,
        iterations: iteration,
        output: lastOutput,
        validation: lastValidation,
        handles,
        totalDurationMs: Date.now() - loopStart,
        reason: 'execute_error',
      };
    }

    // Check if this iteration was interrupted
    const currentState = orchestrator.supervisor.get(handle.id)?.state;
    if (currentState === 'interrupted' || currentState === 'canceled') {
      interrupted = true;
      lastValidation = { passed: false, summary: 'Loop interrupted' };

      onProgress?.({
        iteration,
        maxIterations,
        status: 'interrupted',
        handleId: handle.id,
        durationMs: Date.now() - loopStart,
      });

      break;
    }

    // Run validation
    try {
      lastValidation = await validate(output, iteration);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      lastValidation = { passed: false, summary: `Validation error: ${error}` };
    }

    // Emit iteration event
    orchestrator.eventBus.emit({
      type: 'agent.loop.iteration',
      requestId: registration.sessionId,
      timestamp: Date.now(),
      data: {
        loopId,
        iteration,
        maxIterations,
        passed: lastValidation.passed,
        summary: lastValidation.summary,
        handleId: handle.id,
      },
    });

    if (lastValidation.passed) {
      orchestrator.supervisor.complete(handle.id,
        `Validation passed on iteration ${iteration}`);

      logger.info('agent_loop_passed', {
        loopId, iteration, summary: lastValidation.summary,
      });

      onProgress?.({
        iteration,
        maxIterations,
        status: 'passed',
        validation: lastValidation,
        handleId: handle.id,
        durationMs: Date.now() - loopStart,
      });

      orchestrator.eventBus.emit({
        type: 'agent.loop.end',
        requestId: registration.sessionId,
        timestamp: Date.now(),
        data: {
          loopId, iteration, maxIterations,
          reason: 'validation_passed', passed: true,
        },
      });

      return {
        passed: true,
        iterations: iteration,
        output,
        validation: lastValidation,
        handles,
        totalDurationMs: Date.now() - loopStart,
        reason: 'validation_passed',
      };
    }

    // Validation failed — mark this iteration as completed (it ran fine,
    // just didn't pass the check) and prepare for retry
    orchestrator.supervisor.complete(handle.id,
      `Iteration ${iteration} completed, validation failed: ${lastValidation.summary}`);

    onProgress?.({
      iteration,
      maxIterations,
      status: iteration >= maxIterations ? 'max_iterations' : 'running',
      validation: lastValidation,
      handleId: handle.id,
      durationMs: Date.now() - loopStart,
    });

    // Build retry prompt with fresh context + failure feedback
    if (iteration < maxIterations) {
      currentPrompt = buildRetryPrompt(prompt, lastValidation, iteration);
    }

    logger.debug('agent_loop_retry', {
      loopId, iteration,
      validationSummary: lastValidation.summary,
      nextPromptLength: currentPrompt.length,
    });
  }

  // Loop exhausted or interrupted
  const reason = interrupted ? 'interrupted' as const : 'max_iterations' as const;

  logger.info('agent_loop_end', {
    loopId,
    reason,
    iterations: handles.length,
    totalDurationMs: Date.now() - loopStart,
  });

  orchestrator.eventBus.emit({
    type: 'agent.loop.end',
    requestId: registration.sessionId,
    timestamp: Date.now(),
    data: {
      loopId,
      iteration: handles.length,
      maxIterations,
      reason,
      passed: false,
    },
  });

  return {
    passed: false,
    iterations: handles.length,
    output: lastOutput,
    validation: lastValidation,
    handles,
    totalDurationMs: Date.now() - loopStart,
    reason,
  };
}
