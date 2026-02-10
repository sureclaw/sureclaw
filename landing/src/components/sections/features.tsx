"use client";

import { Reveal } from "@/components/ui/reveal";
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
    title: "Sandboxed Execution",
    description:
      "Every AI agent runs in an isolated sandbox — no network access, no credential leaks, no escape hatches. We support seatbelt, nsjail, and Docker.",
    iconColor: "text-ds-blue",
  },
  {
    icon: Fingerprint,
    title: "Taint Tracking",
    description:
      "Every piece of external content is tagged at the source. We trace it through the entire pipeline so you always know what's user-generated and what isn't.",
    iconColor: "text-ds-purple",
  },
  {
    icon: ScanSearch,
    title: "Prompt Injection Scanning",
    description:
      "Multi-layer scanning catches injection attempts before they reach your LLM. Regex patterns, ML classifiers, and canary tokens — belt, suspenders, and a backup belt.",
    iconColor: "text-ds-cyan",
  },
  {
    icon: Lock,
    title: "Encrypted Credentials",
    description:
      "API keys never enter the sandbox. AES-256-GCM encryption at rest, OS keychain integration, and a paranoid credential store.",
    iconColor: "text-ds-green",
  },
  {
    icon: Layers,
    title: "Provider Architecture",
    description:
      "Every subsystem is a swappable provider. Bring your own LLM, memory store, scanner, or sandbox — the contracts are TypeScript interfaces.",
    iconColor: "text-ds-orange",
  },
  {
    icon: Zap,
    title: "OpenAI-Compatible API",
    description:
      "Drop-in /v1/chat/completions endpoint. Point your existing tools at ax and get security for free.",
    iconColor: "text-ds-red",
  },
];

export function Features() {
  return (
    <section id="features" className="py-16 md:py-20">
      <div className="mx-auto max-w-[1280px] px-8">
        <Reveal>
          <div className="text-center mb-12">
            <h2 className="font-mono text-2xl font-bold tracking-tight mb-3">
              Security you won't notice until it matters
            </h2>
            <p className="text-text-secondary text-sm max-w-[700px] mx-auto leading-relaxed">
              Everything you need to deploy, manage, and scale autonomous AI agents
              with security built into every layer.
            </p>
          </div>
        </Reveal>

        <Reveal>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-[2px] bg-border rounded-xl overflow-hidden border border-border">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="bg-bg-secondary p-7 hover:bg-bg-elevated transition-colors group"
              >
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
                  <h3 className="font-mono text-sm font-semibold text-text-primary">
                    {feature.title}
                  </h3>
                  <p className="text-[13px] text-text-secondary leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
