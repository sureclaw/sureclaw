// src/cli/components/StatusBar.tsx
import React from 'react';
import { Box, Text } from 'ink';

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

export interface StatusBarProps {
  status: ConnectionStatus;
  model?: string;
}

const STATUS_DISPLAY: Record<ConnectionStatus, { symbol: string; color: string; label: string }> = {
  connected:    { symbol: '\u25CF', color: 'green', label: 'Connected' },
  disconnected: { symbol: '\u25CB', color: 'red',   label: 'Disconnected' },
  connecting:   { symbol: '\u25CB', color: 'gray',  label: 'Connecting...' },
};

export function StatusBar({ status, model }: StatusBarProps) {
  const s = STATUS_DISPLAY[status];
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color={s.color}>{s.symbol}</Text>
        {' '}
        <Text color={s.color}>{s.label}</Text>
      </Text>
      {model && <Text color="gray">{model}</Text>}
    </Box>
  );
}
