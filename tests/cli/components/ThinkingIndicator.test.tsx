// tests/cli/components/ThinkingIndicator.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ThinkingIndicator } from '../../../src/cli/components/ThinkingIndicator.js';

describe('ThinkingIndicator', () => {
  it('should show thinking text when visible', () => {
    const { lastFrame } = render(<ThinkingIndicator visible={true} />);
    expect(lastFrame()).toContain('thinking');
  });

  it('should render nothing when not visible', () => {
    const { lastFrame } = render(<ThinkingIndicator visible={false} />);
    expect(lastFrame()?.trim() ?? '').toBe('');
  });
});
