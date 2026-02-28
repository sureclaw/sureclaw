import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEventBus, type StreamEvent, type EventBus } from '../../../src/host/event-bus.js';
import { createOrchestrator, type Orchestrator } from '../../../src/host/orchestration/orchestrator.js';
import { runAgentLoop, type ValidationResult, type LoopProgress } from '../../../src/host/orchestration/agent-loop.js';
import type { AgentRegistration } from '../../../src/host/orchestration/types.js';

function makeRegistration(overrides: Partial<AgentRegistration> = {}): Omit<AgentRegistration, 'activity' | 'metadata'> {
  return {
    agentId: 'coder',
    agentType: 'pi-coding-agent',
    sessionId: 'session-1',
    userId: 'user-1',
    ...overrides,
  };
}

describe('Agent Loop (Ralph pattern)', () => {
  let eventBus: EventBus;
  let orchestrator: Orchestrator;
  let events: StreamEvent[];

  beforeEach(() => {
    eventBus = createEventBus();
    events = [];
    eventBus.subscribe(e => events.push(e));
    orchestrator = createOrchestrator(eventBus);
  });

  it('passes on first iteration when validation succeeds immediately', async () => {
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Build a todo app',
      maxIterations: 5,
      registration: makeRegistration(),
      execute: async () => 'function addTodo() { ... }',
      validate: async () => ({ passed: true, summary: 'All tests pass' }),
    });

    expect(result.passed).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.reason).toBe('validation_passed');
    expect(result.output).toBe('function addTodo() { ... }');
    expect(result.handles).toHaveLength(1);
  });

  it('retries until validation passes', async () => {
    let attempt = 0;
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Fix the bug',
      maxIterations: 5,
      registration: makeRegistration(),
      execute: async (_prompt, iteration) => {
        attempt++;
        return `attempt-${attempt}`;
      },
      validate: async (_output, iteration) => {
        if (iteration < 3) {
          return { passed: false, summary: 'Tests still failing', output: '2 failures' };
        }
        return { passed: true, summary: 'All tests pass' };
      },
    });

    expect(result.passed).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.reason).toBe('validation_passed');
  });

  it('stops at maxIterations when validation never passes', async () => {
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Impossible task',
      maxIterations: 3,
      registration: makeRegistration(),
      execute: async () => 'still broken',
      validate: async () => ({ passed: false, summary: 'Nope' }),
    });

    expect(result.passed).toBe(false);
    expect(result.iterations).toBe(3);
    expect(result.reason).toBe('max_iterations');
    expect(result.handles).toHaveLength(3);
  });

  it('creates a fresh handle per iteration', async () => {
    const handleIds: string[] = [];
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Iterate',
      maxIterations: 3,
      registration: makeRegistration(),
      execute: async (_prompt, _iteration, handle) => {
        handleIds.push(handle.id);
        return 'output';
      },
      validate: async () => ({ passed: false, summary: 'Fail' }),
    });

    // Each iteration should have a unique handle
    expect(new Set(handleIds).size).toBe(3);
    expect(result.handles).toEqual(handleIds);
  });

  it('passes validation failure info in retry prompt', async () => {
    const prompts: string[] = [];
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Original task',
      maxIterations: 3,
      registration: makeRegistration(),
      execute: async (prompt) => {
        prompts.push(prompt);
        return 'output';
      },
      validate: async (_output, iteration) => {
        if (iteration === 1) {
          return { passed: false, summary: 'Test X failed', output: 'Expected 4 got 5' };
        }
        return { passed: true, summary: 'OK' };
      },
    });

    expect(result.passed).toBe(true);
    expect(result.iterations).toBe(2);

    // First iteration gets the original prompt
    expect(prompts[0]).toBe('Original task');

    // Second iteration includes the failure info
    expect(prompts[1]).toContain('Original task');
    expect(prompts[1]).toContain('Test X failed');
    expect(prompts[1]).toContain('Expected 4 got 5');
  });

  it('supports custom retry prompt builder', async () => {
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Task',
      maxIterations: 2,
      registration: makeRegistration(),
      execute: async (prompt) => prompt,
      validate: async (_output, iteration) => {
        if (iteration === 1) return { passed: false, summary: 'Fail' };
        return { passed: true, summary: 'OK' };
      },
      buildRetryPrompt: (original, validation, iteration) =>
        `[RETRY #${iteration}] ${original} | Error: ${validation.summary}`,
    });

    expect(result.passed).toBe(true);
    expect(result.output).toBe('[RETRY #1] Task | Error: Fail');
  });

  it('calls onProgress after each iteration', async () => {
    const progress: LoopProgress[] = [];
    await runAgentLoop(orchestrator, {
      prompt: 'Track me',
      maxIterations: 3,
      registration: makeRegistration(),
      execute: async () => 'output',
      validate: async (_output, iteration) => {
        if (iteration < 3) return { passed: false, summary: `Fail ${iteration}` };
        return { passed: true, summary: 'Pass' };
      },
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toHaveLength(3);
    expect(progress[0].iteration).toBe(1);
    expect(progress[0].status).toBe('running');
    expect(progress[1].iteration).toBe(2);
    expect(progress[1].status).toBe('running');
    expect(progress[2].iteration).toBe(3);
    expect(progress[2].status).toBe('passed');
  });

  it('emits loop events on the event bus', async () => {
    await runAgentLoop(orchestrator, {
      prompt: 'Emit events',
      maxIterations: 2,
      registration: makeRegistration(),
      execute: async () => 'output',
      validate: async (_output, iteration) => {
        if (iteration === 1) return { passed: false, summary: 'Fail' };
        return { passed: true, summary: 'Pass' };
      },
    });

    const loopStart = events.find(e => e.type === 'agent.loop.start');
    expect(loopStart).toBeDefined();
    expect(loopStart!.data.maxIterations).toBe(2);

    const iterations = events.filter(e => e.type === 'agent.loop.iteration');
    expect(iterations).toHaveLength(2);
    expect(iterations[0].data.passed).toBe(false);
    expect(iterations[1].data.passed).toBe(true);

    const loopEnd = events.find(e => e.type === 'agent.loop.end');
    expect(loopEnd).toBeDefined();
    expect(loopEnd!.data.reason).toBe('validation_passed');
    expect(loopEnd!.data.passed).toBe(true);
  });

  it('handles execute errors gracefully', async () => {
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Crash',
      maxIterations: 5,
      registration: makeRegistration(),
      execute: async () => { throw new Error('OOM killed'); },
      validate: async () => ({ passed: true, summary: 'OK' }),
    });

    expect(result.passed).toBe(false);
    expect(result.iterations).toBe(1);
    expect(result.reason).toBe('execute_error');
    expect(result.validation.summary).toContain('OOM killed');
  });

  it('handles validation errors gracefully', async () => {
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Bad validator',
      maxIterations: 2,
      registration: makeRegistration(),
      execute: async () => 'output',
      validate: async () => { throw new Error('Validator crashed'); },
    });

    // Should treat validator error as a failure and retry
    expect(result.passed).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.validation.summary).toContain('Validator crashed');
  });

  it('stops when an iteration handle is interrupted', async () => {
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Interruptible',
      maxIterations: 10,
      registration: makeRegistration(),
      execute: async (_prompt, _iteration, handle) => {
        // Simulate interrupt during execution
        if (_iteration === 2) {
          orchestrator.supervisor.interrupt(handle.id, 'User said stop');
        }
        return 'output';
      },
      validate: async () => ({ passed: false, summary: 'Keep going' }),
    });

    expect(result.passed).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.reason).toBe('interrupted');
  });

  it('marks iteration handles with loop metadata', async () => {
    const handles: string[] = [];
    await runAgentLoop(orchestrator, {
      prompt: 'Metadata check',
      maxIterations: 2,
      registration: makeRegistration(),
      execute: async (_prompt, _iteration, handle) => {
        handles.push(handle.id);
        return 'output';
      },
      validate: async () => ({ passed: false, summary: 'Fail' }),
    });

    for (let i = 0; i < handles.length; i++) {
      const handle = orchestrator.supervisor.get(handles[i]);
      expect(handle).toBeDefined();
      expect(handle!.metadata.pattern).toBe('ralph');
      expect(handle!.metadata.iteration).toBe(i + 1);
      expect(handle!.metadata.maxIterations).toBe(2);
      expect(typeof handle!.metadata.loopId).toBe('string');
    }
  });

  it('reports total duration across all iterations', async () => {
    const result = await runAgentLoop(orchestrator, {
      prompt: 'Duration test',
      maxIterations: 2,
      registration: makeRegistration(),
      execute: async () => {
        await new Promise(r => setTimeout(r, 10)); // Small delay
        return 'output';
      },
      validate: async () => ({ passed: false, summary: 'Fail' }),
    });

    expect(result.totalDurationMs).toBeGreaterThan(0);
  });
});
