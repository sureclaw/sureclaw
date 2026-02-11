// tests/cli/components/Message.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Message } from '../../../src/cli/components/Message.js';

describe('Message', () => {
  it('should render user message with "you" label', () => {
    const { lastFrame } = render(
      <Message role="user" content="Hello" type="normal" />
    );
    const frame = lastFrame();
    expect(frame).toContain('you');
    expect(frame).toContain('Hello');
  });

  it('should render assistant message with "agent" label', () => {
    const { lastFrame } = render(
      <Message role="assistant" content="Hi there" type="normal" />
    );
    const frame = lastFrame();
    expect(frame).toContain('agent');
    expect(frame).toContain('Hi there');
  });

  it('should render error messages', () => {
    const { lastFrame } = render(
      <Message role="system" content="Connection failed" type="error" />
    );
    const frame = lastFrame();
    expect(frame).toContain('error');
    expect(frame).toContain('Connection failed');
  });

  it('should render system messages', () => {
    const { lastFrame } = render(
      <Message role="system" content="Welcome" type="system" />
    );
    const frame = lastFrame();
    expect(frame).toContain('system');
    expect(frame).toContain('Welcome');
  });

  it('should render content for assistant messages', () => {
    const { lastFrame } = render(
      <Message role="assistant" content="Use **bold**" type="normal" />
    );
    const frame = lastFrame();
    expect(frame).toContain('bold');
  });
});
