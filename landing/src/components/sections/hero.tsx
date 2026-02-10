"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StaggerContainer, StaggerItem } from "@/components/ui/reveal";
import { Github, ArrowRight } from "lucide-react";
import { GITHUB_URL, INSTALL_CMD } from "@/lib/constants";

export function Hero() {
  return (
    <section className="pt-32 pb-16 text-center">
      <div className="mx-auto max-w-[1280px] px-8">
        <StaggerContainer className="flex flex-col items-center gap-6" staggerDelay={0.15}>
          {/* Eyebrow badge */}
          <StaggerItem>
            <Badge>open source</Badge>
          </StaggerItem>

          {/* Main heading */}
          <StaggerItem>
            <h1 className="font-mono text-[32px] md:text-[42px] font-bold tracking-tight leading-[1.2] max-w-[900px]">
              <p>Let your agent cook.</p>
              <p className="text-accent">In a fireproof kitchen.</p>
            </h1>
          </StaggerItem>

          {/* Subheading */}
          <StaggerItem>
            <p className="text-[15px] text-text-secondary max-w-[680px] leading-relaxed">
              Define goals, give it skills, and let your agent handle the rest.
              It runs continuously, makes plans, and gets things done
              — with the safeguards that let you sleep at night.
            </p>
          </StaggerItem>

          {/* CTA row */}
          <StaggerItem>
            <div className="flex flex-col sm:flex-row items-center gap-3 mt-2">
              <Button href="#get-started" size="lg">
                get started
                <ArrowRight className="w-4 h-4" />
              </Button>
              <Button
                href={GITHUB_URL}
                variant="outline"
                size="lg"
              >
                view on GitHub
              </Button>
            </div>
          </StaggerItem>

          {/* Install command */}
          <StaggerItem>
            <div className="mt-4 inline-flex items-center gap-3 px-4 py-2.5 rounded-lg bg-bg-secondary border border-border font-mono text-sm text-text-secondary">
              <span className="text-accent">$</span>
              <span>{INSTALL_CMD}</span>
              <button
                className="text-text-tertiary hover:text-accent transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(INSTALL_CMD);
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
    </section>
  );
}
