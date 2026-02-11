// tests/cli/components/StatusBar.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusBar } from '../../../src/cli/components/StatusBar.js';

const baseProps = {
  messageCount: 0,
};

describe('StatusBar', () => {
  it('should show model name', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="claude-sonnet-4-5-20250929" {...baseProps} />
    );
    expect(lastFrame()).toContain('claude-sonnet-4-5-20250929');
  });

  it('should show stream indicator when streaming', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="default" streaming={true} {...baseProps} />
    );
    expect(lastFrame()).toContain('stream');
  });

  it('should show no-stream when not streaming', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="default" streaming={false} {...baseProps} />
    );
    expect(lastFrame()).toContain('no-stream');
  });

  it('should show message count', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="default" {...baseProps} messageCount={5} />
    );
    expect(lastFrame()).toContain('5 msgs');
  });

  it('should show response time when available', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="default" lastResponseMs={1500} {...baseProps} />
    );
    expect(lastFrame()).toContain('1.5s');
  });

  it('should show dash when no response time yet', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="default" {...baseProps} />
    );
    expect(lastFrame()).toContain('-');
  });

  it('should show milliseconds for fast responses', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="default" lastResponseMs={250} {...baseProps} />
    );
    expect(lastFrame()).toContain('250ms');
  });

  it('should show status dot character', () => {
    const { lastFrame } = render(
      <StatusBar status="connected" model="default" {...baseProps} />
    );
    // Should contain a dot character (filled or outline)
    expect(lastFrame()).toMatch(/[●○]/);
  });
});
