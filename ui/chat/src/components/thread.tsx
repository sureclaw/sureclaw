import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  LoaderIcon,
  PencilIcon,
  RefreshCwIcon,
  Square,
} from 'lucide-react';
import {
  ActionBarPrimitive,
  AuiIf,
  ChainOfThoughtPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import { createContext, useContext, type FC } from 'react';
import { MarkdownText } from './markdown-text';

const StatusMessageContext = createContext<string | null>(null);

export const Thread: FC<{ statusMessage?: string | null }> = ({ statusMessage }) => {
  const AssistantMessageWithStatus: FC = () => <AssistantMessage statusMessage={statusMessage} />;

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
          components={{ UserMessage, AssistantMessage: AssistantMessageWithStatus, EditComposer }}
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

const formatArgs = (args: unknown): string => {
  if (args == null || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';
  const params = entries.map(([key, value]) => {
    if (typeof value === 'string') return `${key}: "${value.length > 80 ? value.slice(0, 80) + '\u2026' : value}"`;
    return `${key}: ${JSON.stringify(value)}`;
  }).join(', ');
  return `(${params})`;
};

const ToolCallFallback: FC<{ toolName: string; args: unknown; status: { type: string } }> = ({ toolName, args }) => (
  <div className="px-4 py-1.5 text-[13px] text-muted-foreground font-mono truncate">
    <span className="font-semibold text-foreground">{toolName}</span>{formatArgs(args)}
  </div>
);

const ChainOfThoughtTriggerContent: FC = () => {
  const statusMessage = useContext(StatusMessageContext);
  const isActive = useAuiState((s: Record<string, unknown>) => {
    const cot = s.chainOfThought as { status: { type: string }; parts: unknown[] };
    return cot.status.type === 'running';
  });
  const partsCount = useAuiState((s: Record<string, unknown>) => {
    const cot = s.chainOfThought as { parts: unknown[] };
    return cot.parts.length;
  });
  const collapsed = useAuiState((s: Record<string, unknown>) => {
    const cot = s.chainOfThought as { collapsed: boolean };
    return cot.collapsed;
  });

  return (
    <>
      {collapsed
        ? <ChevronRightIcon className="size-3.5 shrink-0" strokeWidth={1.8} />
        : <ChevronDownIcon className="size-3.5 shrink-0" strokeWidth={1.8} />
      }
      {isActive ? (
        <>
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-amber" strokeWidth={1.8} />
          <span>{'Thinking\u2026'}</span>
        </>
      ) : (
        <span>Done ({partsCount} tool {partsCount === 1 ? 'call' : 'calls'})</span>
      )}
    </>
  );
};

const MyChainOfThought: FC = () => (
  <ChainOfThoughtPrimitive.Root className="my-2 rounded-lg border border-border/40 bg-card/60 backdrop-blur-sm overflow-hidden">
    <ChainOfThoughtPrimitive.AccordionTrigger className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground">
      <ChainOfThoughtTriggerContent />
    </ChainOfThoughtPrimitive.AccordionTrigger>
    <AuiIf condition={(s: Record<string, unknown>) => {
      const cot = s.chainOfThought as { collapsed: boolean };
      return !cot.collapsed;
    }}>
      <div className="border-t border-border/30 py-1">
        <ChainOfThoughtPrimitive.Parts
          components={{
            Reasoning: ({ text }: { text: string }) => (
              <p className="whitespace-pre-wrap px-4 py-1.5 text-[12px] italic text-muted-foreground">{text}</p>
            ),
            tools: {
              Fallback: ToolCallFallback,
            },
          }}
        />
      </div>
    </AuiIf>
  </ChainOfThoughtPrimitive.Root>
);

const ThinkingChip: FC = () => {
  const statusMessage = useContext(StatusMessageContext);
  return (
    <div className="my-2 rounded-lg border border-border/40 bg-card/60 backdrop-blur-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-muted-foreground">
        <ChevronRightIcon className="size-3.5 shrink-0" strokeWidth={1.8} />
        <LoaderIcon className="size-3.5 shrink-0 animate-spin text-amber" strokeWidth={1.8} />
        <span>{statusMessage || 'Thinking\u2026'}</span>
      </div>
    </div>
  );
};

const ThinkingIndicator: FC<{ status: { type: string } }> = ({ status }) => {
  if (status.type !== 'running') return null;
  return <ThinkingChip />;
};

const AssistantMessage: FC<{ statusMessage?: string | null }> = ({ statusMessage }) => (
  <MessagePrimitive.Root asChild>
    <div className="relative mx-auto w-full max-w-[var(--thread-max-width)] py-4 animate-fade-in-up" data-role="assistant">
      <StatusMessageContext.Provider value={statusMessage ?? null}>
        <div className="mx-2 leading-7 break-words text-foreground">
          <MessagePrimitive.Parts
            unstable_showEmptyOnNonTextEnd={false}
            components={{
              Text: MarkdownText,
              ChainOfThought: MyChainOfThought,
              Empty: ThinkingIndicator,
            }}
          />
        </div>
        <AuiIf condition={(s: Record<string, unknown>) => {
          const msg = s.message as { isLast: boolean; parts: { type: string }[] };
          const thr = s.thread as { isRunning: boolean };
          if (!msg.isLast || !thr.isRunning) return false;
          if (!msg.parts || msg.parts.length === 0) return false;
          return !msg.parts.some((p) => p.type === 'tool-call' || p.type === 'reasoning');
        }}>
          <div className="mx-2">
            <ThinkingChip />
          </div>
        </AuiIf>
      </StatusMessageContext.Provider>
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
