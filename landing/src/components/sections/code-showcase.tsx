"use client";

import { Reveal } from "@/components/ui/reveal";

const codeExample = `# ax.yaml — configure your agent
providers:
  llm: anthropic          # or openai, google, etc.
  memory: sqlite          # persistent memory w/ full-text search
  tools: local            # bash, read, write, edit
  web: tavily             # web search via Tavily API
  audit: sqlite           # queryable log of every action

agent:
  model: claude-sonnet    # which model to use
  max_turns: 50           # max reasoning steps per task
  tools:                  # which tools the agent can use
    - bash
    - read_file
    - write_file
    - web_search
    - memory_query`;

const codeHighlighted = codeExample.split("\n").map((line, i) => {
  if (line.startsWith("#") || line.includes("#")) {
    const parts = line.split("#");
    if (line.startsWith("#")) {
      return (
        <span key={i} className="text-text-tertiary">
          {line}
        </span>
      );
    }
    return (
      <span key={i}>
        <span className="text-text-primary">{parts[0]}</span>
        <span className="text-text-tertiary">#{parts.slice(1).join("#")}</span>
      </span>
    );
  }
  if (line.includes(":")) {
    const [key, ...rest] = line.split(":");
    return (
      <span key={i}>
        <span className="text-accent">{key}</span>
        <span className="text-text-tertiary">:</span>
        <span className="text-text-primary">{rest.join(":")}</span>
      </span>
    );
  }
  return (
    <span key={i} className="text-text-primary">
      {line}
    </span>
  );
});

export function CodeShowcase() {
  return (
    <section id="how-it-works" className="py-16 md:py-20">
      <div className="mx-auto max-w-[1280px] px-8">
        <Reveal>
          <div className="text-center mb-12">
            <h2 className="font-mono text-2xl font-bold tracking-tight mb-3">
              Deploy in minutes
            </h2>
            <p className="text-text-secondary text-sm max-w-[700px] mx-auto leading-relaxed">
              Drop an{" "}
              <code className="font-mono text-accent text-xs bg-bg-elevated px-1.5 py-0.5 rounded">
                ax.yaml
              </code>{" "}
              into your project. Pick your LLM, choose your tools, and you&apos;ve got a working agent.
            </p>
          </div>
        </Reveal>

        <Reveal>
          <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden max-w-[900px] mx-auto">
            {/* Code header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-elevated">
              <span className="text-[11px] text-text-secondary font-mono">
                ax.yaml
              </span>
              <button
                className="font-mono text-[10px] px-2.5 py-1 rounded border border-border text-text-secondary hover:text-accent hover:border-accent-dim transition-colors bg-transparent cursor-pointer"
                onClick={() => {
                  navigator.clipboard.writeText(codeExample);
                }}
              >
                copy
              </button>
            </div>
            {/* Code */}
            <pre className="p-6 text-xs font-mono leading-[1.8] overflow-x-auto">
              <code className="flex flex-col gap-0.5">
                {codeHighlighted.map((line, i) => (
                  <span key={i} className="block">
                    {line}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
