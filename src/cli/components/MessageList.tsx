// src/cli/components/MessageList.tsx
import React from 'react';
import { Box } from 'ink';
import { Message } from './Message.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  type: 'normal' | 'error' | 'system';
}

export interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg, i) => (
        <Message
          key={i}
          role={msg.role}
          content={msg.content}
          type={msg.type}
        />
      ))}
    </Box>
  );
}
