import { describe, it, expect, vi } from 'vitest';
import { generateSessionTitle } from '../../src/host/session-title.js';

describe('generateSessionTitle', () => {
  it('generates a short title from user message', async () => {
    const mockLLM = {
      complete: vi.fn().mockResolvedValue('Debug K8s pod crash'),
    };
    const title = await generateSessionTitle('My kubernetes pod keeps crashing with OOMKilled error, how do I fix it?', mockLLM as any);
    expect(title).toBe('Debug K8s pod crash');
    expect(mockLLM.complete).toHaveBeenCalledOnce();
  });

  it('truncates fallback when LLM fails', async () => {
    const mockLLM = {
      complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };
    const longMessage = 'This is a very long message that should be truncated to create a reasonable title for display';
    const title = await generateSessionTitle(longMessage, mockLLM as any);
    expect(title.length).toBeLessThanOrEqual(50);
  });
});
