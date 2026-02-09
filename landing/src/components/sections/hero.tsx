"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Reveal, StaggerContainer, StaggerItem } from "@/components/ui/reveal";
import { LogoLarge } from "@/components/icons/logo";
import { Github, ArrowRight } from "lucide-react";

export function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-[600px] h-[600px] rounded-full bg-accent/10 blur-[120px] glow-pulse" />
      </div>

      {/* Faint grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-[1200px] px-6 text-center pt-24">
        <StaggerContainer className="flex flex-col items-center gap-6" staggerDelay={0.15}>
          {/* Logo */}
          <StaggerItem>
            <LogoLarge className="w-28 md:w-36 h-auto" />
          </StaggerItem>

          {/* Eyebrow badge */}
          <StaggerItem>
            <Badge>Open Source AI Agent Framework</Badge>
          </StaggerItem>

          {/* Main heading */}
          <StaggerItem>
            <h1 className="text-4xl sm:text-5xl md:text-7xl font-bold tracking-tight leading-[1.1] max-w-4xl">
              Like OpenClaw but with{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-accent to-accent-glow">
                trust issues
              </span>{" "}
              <span className="inline-block">&#x1FAE3;</span>
            </h1>
          </StaggerItem>

          {/* Subheading */}
          <StaggerItem>
            <p className="text-lg md:text-xl text-text-secondary max-w-2xl leading-relaxed">
              Build, deploy, and manage AI agents that actually behave.
              ax gives you the guardrails, tooling, and observability
              to go from prototype to production — without the anxiety.
            </p>
          </StaggerItem>

          {/* CTA row */}
          <StaggerItem>
            <div className="flex flex-col sm:flex-row items-center gap-3 mt-2">
              <Button href="#get-started" size="lg">
                Get Started
                <ArrowRight className="w-4 h-4" />
              </Button>
              <Button
                href="https://github.com/ax-llm/ax"
                variant="outline"
                size="lg"
              >
                <Github className="w-4 h-4" />
                View on GitHub
              </Button>
            </div>
          </StaggerItem>

          {/* Install command */}
          <StaggerItem>
            <div className="mt-4 inline-flex items-center gap-3 px-4 py-2.5 rounded-xl bg-bg-secondary border border-border font-mono text-sm text-text-secondary">
              <span className="text-accent-glow">$</span>
              <span>npx ax init</span>
              <button
                className="text-text-tertiary hover:text-text-primary transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText("npx ax init");
                }}
                title="Copy to clipboard"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              </button>
            </div>
          </StaggerItem>
        </StaggerContainer>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-bg-primary to-transparent" />
    </section>
  );
}
