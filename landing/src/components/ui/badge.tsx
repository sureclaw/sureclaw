"use client";

import { cn } from "@/lib/utils";

type BadgeProps = {
  children: React.ReactNode;
  className?: string;
};

export function Badge({ children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5",
        "font-mono text-[10px] font-semibold uppercase tracking-[1.2px]",
        "rounded-md border border-ds-green bg-ds-green-dim text-ds-green",
        className
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-ds-green shadow-[0_0_8px_var(--ds-green-glow)] pulse-dot" />
      {children}
    </span>
  );
}
