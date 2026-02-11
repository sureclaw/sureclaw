// tests/cli/components/MessageList.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageList } from '../../../src/cli/components/MessageList.js';
import type { ChatMessage } from '../../../src/cli/components/MessageList.js';

describe('MessageList', () => {
  it('should render no messages when empty', () => {
    const { lastFrame } = render(<MessageList messages={[]} />);
    expect(lastFrame()).toBeDefined();
  });

  it('should render multiple messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello', type: 'normal' },
      { role: 'assistant', content: 'Hi there', type: 'normal' },
    ];
    const { lastFrame } = render(<MessageList messages={messages} />);
    const frame = lastFrame();
    expect(frame).toContain('Hello');
    expect(frame).toContain('Hi there');
  });

  it('should render error messages', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Something went wrong', type: 'error' },
    ];
    const { lastFrame } = render(<MessageList messages={messages} />);
    expect(lastFrame()).toContain('Something went wrong');
  });

  it('should render system messages', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Welcome to AX', type: 'system' },
    ];
    const { lastFrame } = render(<MessageList messages={messages} />);
    expect(lastFrame()).toContain('Welcome to AX');
  });
});
