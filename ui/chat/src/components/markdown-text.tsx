import type { FC } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';

export const MarkdownText: FC = () => (
  <MarkdownTextPrimitive
    className="prose dark:prose-invert max-w-none prose-p:leading-7 prose-pre:bg-card prose-pre:border prose-pre:border-border/40 prose-pre:rounded-xl prose-pre:backdrop-blur-sm prose-code:font-mono prose-code:text-sm prose-headings:tracking-tight prose-a:text-amber prose-a:no-underline hover:prose-a:underline"
  />
);
