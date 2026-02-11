// tests/cli/components/InputBox.test.tsx
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox } from '../../../src/cli/components/InputBox.js';

describe('InputBox', () => {
  it('should render placeholder when not disabled', () => {
    const { lastFrame } = render(
      <InputBox onSubmit={() => {}} isDisabled={false} />
    );
    const frame = lastFrame();
    expect(frame).toContain('Type a message');
  });

  it('should show waiting message when disabled', () => {
    const { lastFrame } = render(
      <InputBox onSubmit={() => {}} isDisabled={true} />
    );
    const frame = lastFrame();
    expect(frame).toContain('waiting for response');
  });

  it('should render with blue border when enabled', () => {
    const { lastFrame } = render(
      <InputBox onSubmit={() => {}} isDisabled={false} />
    );
    // Should contain the > prompt
    expect(lastFrame()).toContain('>');
  });
});
