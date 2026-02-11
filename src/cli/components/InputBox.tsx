// src/cli/components/InputBox.tsx
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export interface InputBoxProps {
  onSubmit: (value: string) => void;
  isDisabled: boolean;
}

export function InputBox({ onSubmit, isDisabled }: InputBoxProps) {
  const [value, setValue] = useState('');

  const handleSubmit = (submitted: string) => {
    if (!submitted.trim()) return;
    onSubmit(submitted);
    setValue('');
  };

  return (
    <Box borderStyle="single" borderColor={isDisabled ? 'gray' : 'blue'} paddingX={1}>
      <Text color="blue" bold>{'> '}</Text>
      {isDisabled ? (
        <Text color="gray">waiting for response...</Text>
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Type a message or /help for commands..."
        />
      )}
    </Box>
  );
}
