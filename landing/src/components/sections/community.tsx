"use client";

import { useEffect, useRef, useState } from "react";
import { Reveal, StaggerContainer, StaggerItem } from "@/components/ui/reveal";
import { Button } from "@/components/ui/button";
import { Github, MessageCircle } from "lucide-react";

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
      // Ease out cubic
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
    <section className="relative py-24 md:py-32">
      {/* Background glow */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-accent/8 blur-[100px]" />

      <div className="relative mx-auto max-w-[1200px] px-6">
        <Reveal>
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4">
              Built in the open
            </h2>
            <p className="text-text-secondary text-lg max-w-2xl mx-auto">
              ax is free and open source under the MIT license. No paid tiers,
              no gated features. Just a framework you can use, fork,
              and build on.
            </p>
          </div>
        </Reveal>

        {/* Stats */}
        <StaggerContainer
          className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-12"
          staggerDelay={0.1}
        >
          {stats.map((stat) => (
            <StaggerItem key={stat.label}>
              <div className="text-center">
                <div className="text-3xl md:text-4xl font-bold text-text-primary mb-1">
                  <AnimatedCounter
                    target={stat.value}
                    suffix={stat.suffix}
                  />
                </div>
                <div className="text-sm text-text-tertiary">{stat.label}</div>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>

        {/* CTA buttons */}
        <Reveal>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button
              href="https://github.com/ax-llm/ax"
              size="lg"
            >
              <Github className="w-4 h-4" />
              Star on GitHub
            </Button>
            <Button href="#" variant="outline" size="lg">
              <MessageCircle className="w-4 h-4" />
              Join Discord
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
