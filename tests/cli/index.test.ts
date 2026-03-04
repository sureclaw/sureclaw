// tests/cli/index.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeCommand } from '../../src/cli/index.js';

describe('CLI Router', () => {
  it('should route serve command', async () => {
    const mockServe = vi.fn();
    await routeCommand(['serve'], { serve: mockServe });
    expect(mockServe).toHaveBeenCalledOnce();
  });

  it('should route send command with args', async () => {
    const mockSend = vi.fn();
    await routeCommand(['send', 'hello'], { send: mockSend });
    expect(mockSend).toHaveBeenCalledWith(['hello']);
  });

  it('should route configure command', async () => {
    const mockConfigure = vi.fn();
    await routeCommand(['configure'], { configure: mockConfigure });
    expect(mockConfigure).toHaveBeenCalledOnce();
  });

  it('should default to serve if no command', async () => {
    const mockServe = vi.fn();
    await routeCommand([], { serve: mockServe });
    expect(mockServe).toHaveBeenCalledOnce();
  });

  it('should show help for unknown command', async () => {
    const mockHelp = vi.fn();
    await routeCommand(['unknown'], { help: mockHelp });
    expect(mockHelp).toHaveBeenCalledOnce();
  });
});
