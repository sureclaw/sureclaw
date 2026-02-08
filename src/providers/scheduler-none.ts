import type { SchedulerProvider, Config } from './types.js';

export async function create(_config: Config): Promise<SchedulerProvider> {
  return {
    async start() {},
    async stop() {},
  };
}
