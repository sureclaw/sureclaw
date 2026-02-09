"use client";

import { Reveal } from "@/components/ui/reveal";
import { GlassCard } from "@/components/ui/glass-card";
import { ShieldCheck, Eye, Network } from "lucide-react";

const deepDives = [
  {
    icon: ShieldCheck,
    title: "Multi-Step Reasoning",
    description:
      "ax agents don't just answer questions — they break down complex tasks, use tools, check their work, and iterate. Give them a goal and they'll figure out the steps to get there.",
    visual: (
      <div className="relative w-full h-48 flex items-center justify-center">
        {/* Concentric circles representing layers */}
        <div className="absolute w-40 h-40 rounded-full border border-accent/10 animate-[spin_20s_linear_infinite]" />
        <div className="absolute w-28 h-28 rounded-full border border-accent/20 animate-[spin_15s_linear_infinite_reverse]" />
        <div className="absolute w-16 h-16 rounded-full border border-accent/30 animate-[spin_10s_linear_infinite]" />
        <div className="w-6 h-6 rounded-full bg-accent/40 blur-sm" />
      </div>
    ),
  },
  {
    icon: Eye,
    title: "See Everything",
    description:
      "Every LLM call, every tool invocation, every decision your agent makes — logged and queryable. When you need to understand what happened (or debug why it didn't), the full trace is right there.",
    visual: (
      <div className="relative w-full h-48 flex flex-col items-start justify-center gap-2 px-4 font-mono text-xs">
        {[
          { time: "14:23:01", event: "llm_call", status: "ok", color: "text-emerald-400" },
          { time: "14:23:02", event: "tool_use: bash", status: "ok", color: "text-emerald-400" },
          { time: "14:23:03", event: "scan_inbound", status: "clean", color: "text-emerald-400" },
          { time: "14:23:04", event: "scan_outbound", status: "taint:0.3", color: "text-amber-400" },
          { time: "14:23:05", event: "scan_inbound", status: "blocked", color: "text-red-400" },
        ].map((log, i) => (
          <div key={i} className="flex gap-3">
            <span className="text-text-tertiary">{log.time}</span>
            <span className="text-text-secondary">{log.event}</span>
            <span className={log.color}>{log.status}</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: Network,
    title: "Build It Your Way",
    description:
      "Every piece of ax is a TypeScript interface. Swap Anthropic for OpenAI, SQLite for Postgres, add custom tools in a few lines. Use what works for you — we don't lock you into anything.",
    visual: (
      <div className="relative w-full h-48 flex items-center justify-center">
        <div className="grid grid-cols-3 gap-3">
          {["LLM", "Memory", "Scanner", "Sandbox", "Creds", "Audit"].map(
            (name) => (
              <div
                key={name}
                className="px-3 py-2 rounded-lg bg-bg-elevated border border-border text-xs font-mono text-text-secondary text-center"
              >
                {name}
              </div>
            )
          )}
        </div>
      </div>
    ),
  },
];

export function DeepDives() {
  return (
    <section className="relative py-24 md:py-32">
      <div className="mx-auto max-w-[1200px] px-6 flex flex-col gap-24">
        {deepDives.map((item, index) => (
          <div
            key={item.title}
            className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center"
          >
            {/* Text */}
            <Reveal
              direction={index % 2 === 0 ? "left" : "right"}
              className={index % 2 === 1 ? "lg:order-2" : ""}
            >
              <div className="flex flex-col gap-4">
                <div className="w-10 h-10 rounded-lg bg-bg-elevated border border-border flex items-center justify-center text-accent-glow">
                  <item.icon className="w-5 h-5" />
                </div>
                <h3 className="text-2xl md:text-3xl font-bold tracking-tight">
                  {item.title}
                </h3>
                <p className="text-text-secondary leading-relaxed">
                  {item.description}
                </p>
              </div>
            </Reveal>

            {/* Visual */}
            <Reveal
              direction={index % 2 === 0 ? "right" : "left"}
              className={index % 2 === 1 ? "lg:order-1" : ""}
            >
              <GlassCard hover={false}>{item.visual}</GlassCard>
            </Reveal>
          </div>
        ))}
      </div>
    </section>
  );
}
