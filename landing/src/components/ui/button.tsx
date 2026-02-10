"use client";

import { cn } from "@/lib/utils";
import { ButtonHTMLAttributes, AnchorHTMLAttributes } from "react";

type Variant = "solid" | "ghost" | "outline";
type Size = "sm" | "md" | "lg";

const variantStyles: Record<Variant, string> = {
  solid:
    "bg-accent text-bg-primary hover:bg-accent-glow hover:-translate-y-px",
  ghost:
    "bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-elevated",
  outline:
    "bg-transparent border border-border-hover text-text-secondary hover:text-text-primary hover:bg-bg-elevated",
};

const sizeStyles: Record<Size, string> = {
  sm: "px-4 py-2 text-xs rounded-md",
  md: "px-6 py-3 text-[13px] rounded-lg",
  lg: "px-6 py-3 text-[13px] rounded-lg",
};

type ButtonProps = {
  variant?: Variant;
  size?: Size;
} & (
  | (ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined })
  | (AnchorHTMLAttributes<HTMLAnchorElement> & { href: string })
);

export function Button({
  variant = "solid",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  const classes = cn(
    "inline-flex items-center justify-center gap-2 font-mono font-semibold transition-all duration-200 cursor-pointer",
    variantStyles[variant],
    sizeStyles[size],
    className
  );

  if ("href" in props && props.href) {
    return <a className={classes} {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)} />;
  }

  return <button className={classes} {...(props as ButtonHTMLAttributes<HTMLButtonElement>)} />;
}
