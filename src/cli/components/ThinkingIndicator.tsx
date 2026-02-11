// src/cli/components/ThinkingIndicator.tsx
import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface ThinkingIndicatorProps {
  visible: boolean;
}

export function ThinkingIndicator({ visible }: ThinkingIndicatorProps) {
  if (!visible) return null;
  return (
    <Box paddingX={1} marginBottom={1}>
      <Text color="green">
        <Spinner type="dots" />
      </Text>
      <Text color="gray"> thinking...</Text>
    </Box>
  );
}
