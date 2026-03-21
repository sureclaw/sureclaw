import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
  Square,
} from 'lucide-react';
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from '@assistant-ui/react';
import type { FC } from 'react';
import { MarkdownText } from './markdown-text';

export const Thread: FC = () => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root flex h-full flex-col bg-background"
      style={{ ['--thread-max-width' as string]: '44rem' }}
    >
      <ThreadPrimitive.Viewport className="aui-thread-viewport relative flex flex-1 flex-col overflow-y-auto px-4">
        <ThreadPrimitive.If empty>
          <ThreadWelcome />
        </ThreadPrimitive.If>

        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage, EditComposer }}
        />

        <ThreadPrimitive.If empty={false}>
          <div className="min-h-8 grow" />
        </ThreadPrimitive.If>

        <Composer />
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadWelcome: FC = () => (
  <div className="mx-auto my-auto flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col items-center justify-center animate-fade-in-up">
    <p className="text-2xl font-semibold tracking-tight">Hello there!</p>
    <p className="text-lg text-muted-foreground/65 mt-1">How can I help you today?</p>
  </div>
);

const Composer: FC = () => (
  <div className="sticky bottom-0 mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-4 rounded-t-3xl bg-background pb-4 md:pb-6">
    <ThreadPrimitive.ScrollToBottom asChild>
      <button className="absolute -top-12 z-10 self-center rounded-full border border-border/50 bg-card p-2 shadow-sm hover:bg-accent transition-colors duration-150 disabled:invisible">
        <ArrowDownIcon className="size-4 text-muted-foreground" />
      </button>
    </ThreadPrimitive.ScrollToBottom>
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      <div className="flex w-full flex-col rounded-2xl border border-border/50 bg-card/80 px-1 pt-2 shadow-xs backdrop-blur-sm transition-all duration-150 has-[textarea:focus-visible]:border-amber/30 has-[textarea:focus-visible]:ring-[3px] has-[textarea:focus-visible]:ring-amber/10">
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          className="mb-1 max-h-32 min-h-16 w-full resize-none bg-transparent px-3.5 pt-1.5 pb-3 text-[14px] outline-none placeholder:text-muted-foreground"
          rows={1}
          autoFocus
        />
        <div className="relative mx-1 mt-2 mb-2 flex items-center justify-end">
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <button className="rounded-full bg-amber p-1.5 text-primary-foreground hover:bg-amber/90 transition-colors duration-150">
                <ArrowUpIcon className="size-4" />
              </button>
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel asChild>
              <button className="rounded-full bg-muted p-1.5 hover:bg-muted/80 transition-colors duration-150">
                <Square className="size-3.5" fill="currentColor" />
              </button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </div>
    </ComposerPrimitive.Root>
  </div>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="relative mx-auto w-full max-w-[var(--thread-max-width)] py-4 animate-fade-in-up" data-role="assistant">
      <div className="mx-2 leading-7 break-words text-foreground">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
      <div className="mt-2 ml-2 flex">
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="not-last"
          className="flex gap-1 text-muted-foreground"
        >
          <ActionBarPrimitive.Copy asChild>
            <button className="p-1 hover:text-foreground transition-colors duration-150">
              <MessagePrimitive.If copied><CheckIcon className="size-4 text-emerald" /></MessagePrimitive.If>
              <MessagePrimitive.If copied={false}><CopyIcon className="size-4" /></MessagePrimitive.If>
            </button>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <button className="p-1 hover:text-foreground transition-colors duration-150">
              <RefreshCwIcon className="size-4" />
            </button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </div>
  </MessagePrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="mx-auto grid w-full max-w-[var(--thread-max-width)] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 px-2 py-4 [&>*]:col-start-2" data-role="user">
      <div className="relative col-start-2 min-w-0">
        <div className="rounded-2xl bg-card border border-border/40 px-5 py-2.5 break-words text-foreground backdrop-blur-sm">
          <MessagePrimitive.Parts />
        </div>
        <div className="absolute top-1/2 left-0 -translate-x-full -translate-y-1/2 pr-2">
          <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex flex-col items-end">
            <ActionBarPrimitive.Edit asChild>
              <button className="p-1 text-muted-foreground hover:text-foreground transition-colors duration-150">
                <PencilIcon className="size-4" />
              </button>
            </ActionBarPrimitive.Edit>
          </ActionBarPrimitive.Root>
        </div>
      </div>
    </div>
  </MessagePrimitive.Root>
);

const EditComposer: FC = () => (
  <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-4 px-2 first:mt-4">
    <ComposerPrimitive.Root className="ml-auto flex w-full max-w-7/8 flex-col rounded-xl bg-card border border-border/40">
      <ComposerPrimitive.Input
        className="flex min-h-[60px] w-full resize-none bg-transparent p-4 text-foreground outline-none"
        autoFocus
      />
      <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <button className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground transition-all duration-150">Cancel</button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <button className="rounded-lg bg-amber px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-amber/90 transition-colors duration-150">Update</button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </div>
);
