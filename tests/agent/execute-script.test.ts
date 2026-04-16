import { describe, it, expect } from 'vitest';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('execute_script tool spec', () => {
  it('is defined in tool catalog', async () => {
    const { TOOL_CATALOG } = await import('../../src/agent/tool-catalog.js');
    const spec = TOOL_CATALOG.find(t => t.name === 'execute_script');
    expect(spec).toBeDefined();
    expect(spec!.category).toBe('sandbox');
    expect(spec!.singletonAction).toBe('execute_script');
  });

  it('executes locally without IPC — no host handler needed', async () => {
    // execute_script runs in-process (Node.js + filesystem only),
    // so it should NOT have an IPC schema on the host side.
    const { IPC_SCHEMAS } = await import('../../src/ipc-schemas.js');
    expect(IPC_SCHEMAS['execute_script']).toBeUndefined();
  });
});
