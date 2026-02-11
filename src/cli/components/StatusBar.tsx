// src/cli/components/StatusBar.tsx
import React from 'react';
import { Box, Text } from 'ink';

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

export interface StatusBarProps {
  status: ConnectionStatus;
  model?: string;
  streaming?: boolean;
  /** Milliseconds the last response took (undefined = no response yet) */
  lastResponseMs?: number;
  /** Number of messages in the conversation */
  messageCount: number;
}

const STATUS_DOT: Record<ConnectionStatus, { symbol: string; color: string }> = {
  connected:    { symbol: '\u25CF', color: 'green' },
  disconnected: { symbol: '\u25CF', color: 'red' },
  connecting:   { symbol: '\u25CB', color: 'yellow' },
};

function formatResponseTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StatusBar({ status, model, streaming = true, lastResponseMs, messageCount }: StatusBarProps) {
  const dot = STATUS_DOT[status];
  const sep = <Text color="gray"> | </Text>;

  return (
    <Box>
      <Text color={dot.color}>{dot.symbol}</Text>
      <Text> </Text>
      {model && <><Text color="cyan">{model}</Text>{sep}</>}
      <Text color={streaming ? 'green' : 'gray'}>{streaming ? 'stream' : 'no-stream'}</Text>
      {sep}
      <Text color="gray">{messageCount} msgs</Text>
      {sep}
      <Text color="gray">{lastResponseMs !== undefined ? formatResponseTime(lastResponseMs) : '-'}</Text>
    </Box>
  );
}
