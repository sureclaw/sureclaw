import type { WebExtractProvider } from './types.js';
import type { Config } from '../../types.js';
import { disabledProvider } from '../../utils/disabled-provider.js';

export async function create(_config: Config): Promise<WebExtractProvider> {
  return disabledProvider<WebExtractProvider>();
}
