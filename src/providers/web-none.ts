import type { WebProvider, Config } from './types.js';

export async function create(_config: Config): Promise<WebProvider> {
  return {
    async fetch() {
      throw new Error('Provider disabled (provider: none)');
    },

    async search() {
      throw new Error('Provider disabled (provider: none)');
    },
  };
}
