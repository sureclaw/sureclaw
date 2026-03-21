import type { FC } from 'react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import { PlusIcon } from 'lucide-react';

export const ThreadList: FC = () => (
  <ThreadListPrimitive.Root className="flex flex-col items-stretch gap-0.5">
    <ThreadListNew />
    <ThreadListItems />
  </ThreadListPrimitive.Root>
);

const ThreadListNew: FC = () => (
  <div className="px-0 py-2">
    <ThreadListPrimitive.New asChild>
      <button className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground/80 transition-all duration-150">
        <PlusIcon className="size-4 text-amber" />
        New Chat
      </button>
    </ThreadListPrimitive.New>
  </div>
);

const ThreadListItems: FC = () => {
  const isLoading = useAuiState(({ threads }) => threads.isLoading);

  if (isLoading) {
    return (
      <>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-2 rounded-lg px-3 py-2.5">
            <div className="h-4 flex-grow animate-pulse rounded bg-foreground/[0.04]" />
          </div>
        ))}
      </>
    );
  }

  return <ThreadListPrimitive.Items components={{ ThreadListItem }} />;
};

const ThreadListItem: FC = () => (
  <ThreadListItemPrimitive.Root className="flex items-center gap-2 rounded-lg transition-all duration-150 hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] data-active:bg-foreground/[0.06]">
    <ThreadListItemPrimitive.Trigger className="truncate grow px-3 py-2.5 text-start">
      <span className="text-[13px] font-medium text-muted-foreground data-active:text-foreground">
        <ThreadListItemPrimitive.Title fallback="New Chat" />
      </span>
    </ThreadListItemPrimitive.Trigger>
  </ThreadListItemPrimitive.Root>
);
