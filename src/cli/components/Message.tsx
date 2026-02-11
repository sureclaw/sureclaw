// src/cli/components/Message.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { renderMarkdown } from '../utils/markdown.js';

export interface MessageProps {
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  type: 'normal' | 'error' | 'system';
}

const STYLE: Record<string, { borderColor: string; label: string }> = {
  user:      { borderColor: 'blue',   label: 'you' },
  assistant: { borderColor: 'green',  label: 'agent' },
  error:     { borderColor: 'red',    label: 'error' },
  system:    { borderColor: 'yellow', label: 'system' },
};

export function Message({ role, content, type }: MessageProps) {
  const effectiveRole = type === 'error' ? 'error' : type === 'system' ? 'system' : role;
  const style = STYLE[effectiveRole] ?? STYLE.system;

  // Render markdown for assistant messages, plain text for everything else
  const rendered = role === 'assistant' ? renderMarkdown(content) : content;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={style.borderColor}
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color={style.borderColor}>{style.label}</Text>
      <Text>{rendered}</Text>
    </Box>
  );
}
