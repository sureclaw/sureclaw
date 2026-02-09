import type { BrowserProvider, Config } from '../types.js';

export async function create(_config: Config): Promise<BrowserProvider> {
  return {
    async launch() {
      throw new Error('Provider disabled (provider: none)');
    },
    async navigate() {
      throw new Error('Provider disabled (provider: none)');
    },
    async snapshot() {
      throw new Error('Provider disabled (provider: none)');
    },
    async click() {
      throw new Error('Provider disabled (provider: none)');
    },
    async type() {
      throw new Error('Provider disabled (provider: none)');
    },
    async screenshot() {
      throw new Error('Provider disabled (provider: none)');
    },
    async close() {
      throw new Error('Provider disabled (provider: none)');
    },
  };
}
