/**
 * IPC handlers: scheduler operations (add_cron, run_at, remove_cron, list_jobs).
 */
import { randomUUID } from 'node:crypto';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';

export function createSchedulerHandlers(providers: ProviderRegistry, agentName: string) {
  return {
    scheduler_add_cron: async (req: any, ctx: IPCContext) => {
      const jobId = randomUUID();
      providers.scheduler.addCron?.({
        id: jobId,
        schedule: req.schedule,
        agentId: agentName,
        prompt: req.prompt,
        maxTokenBudget: req.maxTokenBudget,
        delivery: req.delivery ?? { mode: 'channel', target: 'last' },
      });
      await providers.audit.log({
        action: 'scheduler_add_cron',
        sessionId: ctx.sessionId,
        args: { jobId, schedule: req.schedule },
        result: 'success',
        timestamp: new Date(),
        durationMs: 0,
      });
      return { jobId };
    },

    scheduler_run_at: async (req: any, ctx: IPCContext) => {
      const dt = new Date(req.datetime);
      if (isNaN(dt.getTime())) {
        return { ok: false, error: 'Invalid datetime string' };
      }
      const schedule = `${dt.getMinutes()} ${dt.getHours()} ${dt.getDate()} ${dt.getMonth() + 1} *`;
      const jobId = randomUUID();
      const job = {
        id: jobId,
        schedule,
        agentId: agentName,
        prompt: req.prompt,
        maxTokenBudget: req.maxTokenBudget,
        delivery: req.delivery ?? { mode: 'channel', target: 'last' },
        runOnce: true,
      };
      // Use setTimeout-based scheduleOnce for precise timing; fall back to cron
      if (providers.scheduler.scheduleOnce) {
        providers.scheduler.scheduleOnce(job, dt);
      } else {
        providers.scheduler.addCron?.(job);
      }
      await providers.audit.log({
        action: 'scheduler_run_at',
        sessionId: ctx.sessionId,
        args: { jobId, datetime: req.datetime, schedule },
        result: 'success',
        timestamp: new Date(),
        durationMs: 0,
      });
      return { jobId, schedule };
    },

    scheduler_remove_cron: async (req: any, ctx: IPCContext) => {
      providers.scheduler.removeCron?.(req.jobId);
      await providers.audit.log({
        action: 'scheduler_remove_cron',
        sessionId: ctx.sessionId,
        args: { jobId: req.jobId },
        result: 'success',
        timestamp: new Date(),
        durationMs: 0,
      });
      return { removed: true };
    },

    scheduler_list_jobs: async () => {
      const jobs = providers.scheduler.listJobs?.() ?? [];
      return { jobs };
    },
  };
}
