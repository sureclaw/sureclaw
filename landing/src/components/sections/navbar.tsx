"use client";

import { useState } from "react";
import { Logo } from "@/components/icons/logo";
import { Github, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PROJECT_NAME, GITHUB_URL } from "@/lib/constants";

const navLinks = [
  { label: "features", href: "#features" },
  { label: "how it works", href: "#how-it-works" },
  { label: "GitHub", href: GITHUB_URL },
  { label: "docs", href: "#" },
];

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-bg-secondary backdrop-blur-xl">
      <div className="mx-auto max-w-[1280px] px-8 h-16 flex items-center justify-between">
        {/* Logo */}
        <a href="/" className="flex items-center gap-2.5">
          <Logo className="w-7 h-7" />
          <span className="font-mono font-bold text-[15px] tracking-tight text-accent">
            {PROJECT_NAME}
          </span>
        </a>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-7">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="font-mono text-xs font-medium text-text-secondary hover:text-text-primary transition-colors duration-200"
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* Desktop CTA */}
        <div className="hidden md:flex items-center gap-4">
          <a
            href={GITHUB_URL}
            className="text-text-tertiary hover:text-text-primary transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github className="w-4 h-4" />
          </a>
          <a
            href="#get-started"
            className={cn(
              "font-mono text-xs font-semibold px-4 py-2 rounded-md",
              "border border-accent-dim text-accent",
              "hover:bg-accent-subtle hover:border-accent transition-all duration-200"
            )}
          >
            get started →
          </a>
        </div>

        {/* Mobile hamburger */}
        <button
          className="md:hidden p-2 text-text-secondary hover:text-text-primary"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden border-t border-border bg-bg-secondary">
          <div className="px-8 py-4 flex flex-col gap-2">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="font-mono px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
                onClick={() => setMobileOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <a
              href="#get-started"
              className="font-mono text-xs font-semibold px-4 py-2 rounded-md border border-accent-dim text-accent hover:bg-accent-subtle mt-2 text-center transition-all"
              onClick={() => setMobileOpen(false)}
            >
              get started →
            </a>
          </div>
        </div>
      )}
    </nav>
  );
}
