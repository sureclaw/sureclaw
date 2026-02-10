"use client";

import { useEffect, useRef, useState } from "react";
import { Reveal } from "@/components/ui/reveal";
import { Button } from "@/components/ui/button";
import { Github, MessageCircle } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";

function AnimatedCounter({
  target,
  suffix = "",
  duration = 1500,
}: {
  target: number;
  suffix?: string;
  duration?: number;
}) {
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          setStarted(true);
        }
      },
      { threshold: 0.5 }
    );

    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started) return;

    const startTime = Date.now();
    const step = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * target));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [started, target, duration]);

  return (
    <span ref={ref}>
      {count.toLocaleString()}
      {suffix}
    </span>
  );
}

const stats = [
  { label: "GitHub Stars", value: 500, suffix: "+" },
  { label: "Contributors", value: 12, suffix: "" },
  { label: "Providers", value: 18, suffix: "" },
  { label: "Tests Passing", value: 483, suffix: "" },
];

export function Community() {
  return (
    <section className="py-16 md:py-20">
      <div className="mx-auto max-w-[1280px] px-8">
        {/* Stats grid */}
        <Reveal>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-[2px] bg-border rounded-xl overflow-hidden border border-border mb-20 max-w-[1100px] mx-auto">
            {stats.map((stat) => (
              <div key={stat.label} className="bg-bg-secondary py-8 px-6 text-center">
                <div className="font-mono text-4xl font-bold text-accent mb-2">
                  <AnimatedCounter
                    target={stat.value}
                    suffix={stat.suffix}
                  />
                </div>
                <div className="text-xs text-text-secondary uppercase tracking-wider font-medium">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </Reveal>

        {/* CTA box */}
        <Reveal>
          <div className="bg-bg-secondary border border-border-hover rounded-xl py-14 px-12 text-center max-w-[800px] mx-auto">
            <h2 className="font-mono text-[28px] font-bold tracking-tight mb-3">
              Built in the open
            </h2>
            <p className="text-sm text-text-secondary mb-8 leading-relaxed max-w-lg mx-auto">
              ax is free and open source under the MIT license. No paid tiers,
              no gated features. Just a framework you can use, fork,
              and build on.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button href={GITHUB_URL} size="lg">
                <Github className="w-4 h-4" />
                star on GitHub
              </Button>
              <Button href="#" variant="outline" size="lg">
                <MessageCircle className="w-4 h-4" />
                join Discord
              </Button>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
