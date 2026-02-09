"use client";

import { GlassCard } from "@/components/ui/glass-card";
import { Reveal, StaggerContainer, StaggerItem } from "@/components/ui/reveal";
import {
  Shield,
  Fingerprint,
  ScanSearch,
  Lock,
  Layers,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

const features = [
  {
    icon: Shield,
    title: "Autonomous Agents",
    description:
      "Define a goal and let your agent figure out the rest. ax agents run continuously, use tools, make decisions, and handle multi-step tasks on their own.",
    iconColor: "text-indigo-400",
  },
  {
    icon: Fingerprint,
    title: "Pluggable Tools",
    description:
      "Connect any tool — bash, file I/O, web search, APIs, databases. Write your own in a few lines of TypeScript or use the built-in ones.",
    iconColor: "text-violet-400",
  },
  {
    icon: ScanSearch,
    title: "Any LLM",
    description:
      "Anthropic, OpenAI, or anything with an API. Swap models with a single config change — no code rewrites, no vendor lock-in.",
    iconColor: "text-sky-400",
  },
  {
    icon: Lock,
    title: "Persistent Memory",
    description:
      "Agents remember across conversations. Built-in SQLite with full-text search, or bring your own storage — it's just a TypeScript interface.",
    iconColor: "text-emerald-400",
  },
  {
    icon: Layers,
    title: "Everything Is Swappable",
    description:
      "LLM, memory, tools, sandbox — every subsystem is a provider you can replace. Start with defaults, swap pieces as you grow.",
    iconColor: "text-amber-400",
  },
  {
    icon: Zap,
    title: "OpenAI-Compatible API",
    description:
      "Expose your agents as a /v1/chat/completions endpoint. Works with any tool that speaks the OpenAI protocol.",
    iconColor: "text-rose-400",
  },
];

export function Features() {
  return (
    <section id="features" className="relative py-24 md:py-32">
      <div className="mx-auto max-w-[1200px] px-6">
        <Reveal>
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4">
              Everything you need to{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-accent to-accent-glow">
                build real agents
              </span>
            </h2>
            <p className="text-text-secondary text-lg max-w-2xl mx-auto">
              ax is a batteries-included, open source framework for building
              AI agents that do real work. Free forever, MIT licensed.
            </p>
          </div>
        </Reveal>

        <StaggerContainer
          className="grid grid-cols-1 md:grid-cols-3 gap-4"
          staggerDelay={0.1}
        >
          {features.map((feature) => (
            <StaggerItem key={feature.title}>
              <GlassCard className="h-full group">
                <div className="flex flex-col gap-3">
                  <div
                    className={cn(
                      "w-10 h-10 rounded-lg flex items-center justify-center",
                      "bg-bg-elevated border border-border group-hover:border-border-hover transition-colors",
                      feature.iconColor
                    )}
                  >
                    <feature.icon className="w-5 h-5" />
                  </div>
                  <h3 className="text-lg font-semibold text-text-primary">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </GlassCard>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </section>
  );
}
