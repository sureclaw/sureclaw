/**
 * Scenario: Scheduled tasks and cron triggers
 *
 * Tests scheduler IPC actions: adding cron jobs, one-shot scheduled tasks,
 * listing and removing jobs, and simulating cron job execution.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn } from '../scripted-llm.js';

describe('E2E Scenario: Scheduled Tasks', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('scheduler_add_cron creates a recurring job via IPC', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('scheduler_add_cron', {
      schedule: '0 9 * * 1-5',
      prompt: 'Good morning! Time for standup.',
    });

    expect(result.ok).toBe(true);
    expect(result.jobId).toBeDefined();

    // Job is in the scheduler
    expect(harness.schedulerJobs.length).toBe(1);
    expect(harness.schedulerJobs[0]!.schedule).toBe('0 9 * * 1-5');
    expect(harness.schedulerJobs[0]!.prompt).toBe('Good morning! Time for standup.');
  });

  test('scheduler_run_at creates a one-shot job via IPC', async () => {
    harness = await TestHarness.create();

    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const result = await harness.ipcCall('scheduler_run_at', {
      datetime: futureDate,
      prompt: 'Remind me to check the deploy.',
    });

    expect(result.ok).toBe(true);
    expect(result.jobId).toBeDefined();

    // Job is in the scheduler
    expect(harness.schedulerOnceJobs.length).toBe(1);
    expect(harness.schedulerOnceJobs[0]!.job.prompt).toBe('Remind me to check the deploy.');
    expect(harness.schedulerOnceJobs[0]!.job.runOnce).toBe(true);
  });

  test('scheduler_list_jobs returns all registered jobs', async () => {
    harness = await TestHarness.create();

    // Add two jobs
    await harness.ipcCall('scheduler_add_cron', {
      schedule: '0 9 * * *',
      prompt: 'Morning check',
    });
    await harness.ipcCall('scheduler_add_cron', {
      schedule: '0 17 * * *',
      prompt: 'Evening summary',
    });

    const result = await harness.ipcCall('scheduler_list_jobs', {});

    expect(result.ok).toBe(true);
    expect(result.jobs.length).toBe(2);
  });

  test('scheduler_remove_cron deletes a job', async () => {
    harness = await TestHarness.create();

    const addResult = await harness.ipcCall('scheduler_add_cron', {
      schedule: '0 12 * * *',
      prompt: 'Lunch reminder',
    });

    expect(harness.schedulerJobs.length).toBe(1);

    const removeResult = await harness.ipcCall('scheduler_remove_cron', {
      jobId: addResult.jobId,
    });

    expect(removeResult.ok).toBe(true);
    expect(harness.schedulerJobs.length).toBe(0);
  });

  test('cron job fires and calls LLM with the prompt', async () => {
    harness = await TestHarness.create({
      llmTurns: [
        // scheduler_add_cron does NOT call LLM, so the first turn is for fireCronJob
        textTurn('Good morning! Here is your standup summary.'),
      ],
    });

    // Schedule the job (this does NOT consume an LLM turn)
    await harness.ipcCall('scheduler_add_cron', {
      schedule: '0 9 * * 1-5',
      prompt: 'Generate standup summary',
    });

    // Simulate the cron job firing
    const job = harness.schedulerJobs[0]!;
    const fireResult = await harness.fireCronJob(job);

    expect(fireResult.llmResponse).toBe('Good morning! Here is your standup summary.');
  });

  test('scheduler_add_cron with custom delivery target', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('scheduler_add_cron', {
      schedule: '30 8 * * *',
      prompt: 'Daily digest',
      delivery: {
        mode: 'channel',
        target: {
          provider: 'slack',
          scope: 'channel',
          identifiers: { channel: 'C123456' },
        },
      },
    });

    expect(result.ok).toBe(true);
    const job = harness.schedulerJobs[0]!;
    expect(job.delivery?.mode).toBe('channel');
    expect(job.delivery?.target).not.toBe('last');
  });

  test('scheduler actions are audited', async () => {
    harness = await TestHarness.create();

    await harness.ipcCall('scheduler_add_cron', {
      schedule: '0 * * * *',
      prompt: 'Hourly check',
    });

    expect(harness.wasAudited('scheduler_add_cron')).toBe(true);
  });
});
