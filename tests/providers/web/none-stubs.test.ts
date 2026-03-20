import { describe, test, expect } from 'vitest';
import type { Config } from '../../../src/types.js';

const config = {} as unknown as Config;

describe('none-extract', () => {
  test('extract() throws disabled error', async () => {
    const { create } = await import('../../../src/providers/web/none-extract.js');
    const provider = await create(config);
    expect(() => provider.extract('https://example.com')).toThrow('disabled');
  });
});

describe('none-search', () => {
  test('search() throws disabled error', async () => {
    const { create } = await import('../../../src/providers/web/none-search.js');
    const provider = await create(config);
    expect(() => provider.search('test')).toThrow('disabled');
  });
});
