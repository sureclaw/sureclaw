// tests/cli/components/StatusBar.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusBar } from '../../../src/cli/components/StatusBar.js';

describe('StatusBar', () => {
  it('should show connected status', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="claude-sonnet-4-5-20250929" />
    );
    const frame = lastFrame();
    expect(frame).toContain('Connected');
    expect(frame).toContain('claude-sonnet-4-5-20250929');
  });

  it('should show disconnected status', () => {
    const { lastFrame } = render(
      <StatusBar status="disconnected" model="default" />
    );
    const frame = lastFrame();
    expect(frame).toContain('Disconnected');
  });

  it('should show connecting status', () => {
    const { lastFrame } = render(
      <StatusBar status="connecting" model="default" />
    );
    const frame = lastFrame();
    expect(frame).toContain('Connecting');
  });
});
