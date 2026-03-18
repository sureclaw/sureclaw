/**
 * Static skill screener — 5-layer content analyzer.
 *
 * Layers:
 *   1. Hard-reject: exec, eval, spawn, child_process, base64 → BLOCK
 *   2. Exfiltration: URLs with data params, webhooks, ngrok → FLAG
 *   3. Prompt injection: HTML comment overrides, zero-width chars, role reassignment → FLAG
 *   4. External dependencies: CDN scripts, external binary URLs → FLAG
 *   5. Permission manifest: undeclared capabilities → FLAG
 *
 * Scoring: Any BLOCK → REJECT. Score ≥ 0.8 → REJECT. ≥ 0.3 → REVIEW. Else APPROVE.
 */

import type { Config } from '../../types.js';
import type {
  SkillScreenerProvider,
  ScreeningVerdict,
  ExtendedScreeningVerdict,
  ScreeningReason,
  ScreeningVerdictKind,
} from './types.js';

// ═══════════════════════════════════════════════════════
// Layer 1: Hard-reject patterns (BLOCK)
// ═══════════════════════════════════════════════════════

const HARD_REJECT: { regex: RegExp; detail: string }[] = [
  { regex: /\bexec\s*\(/i, detail: 'exec() call detected' },
  { regex: /\bchild_process\b/i, detail: 'child_process module reference' },
  { regex: /\bspawn\s*\(/i, detail: 'spawn() call detected' },
  { regex: /\bexecSync\s*\(/i, detail: 'execSync() call detected' },
  { regex: /\$\(\s*(curl|wget|nc|bash|sh)\b/i, detail: 'shell command substitution' },
  { regex: /\|\s*(bash|sh|zsh|cmd|powershell)\b/i, detail: 'pipe to shell' },
  { regex: /\beval\s*\(/i, detail: 'eval() call detected' },
  { regex: /\bnew\s+Function\s*\(/i, detail: 'Function constructor detected' },
  { regex: /\batob\s*\(/i, detail: 'atob() base64 decode detected' },
  { regex: /\bBuffer\.from\s*\([^)]*,\s*['"]base64['"]\s*\)/i, detail: 'base64 Buffer.from detected' },
  { regex: /\brequire\s*\(\s*['"](?:child_process|net|dgram|cluster|worker_threads)['"]\s*\)/i, detail: 'dangerous module require' },
  { regex: /\bimport\s+.*from\s+['"](?:child_process|net|dgram|cluster|worker_threads)['"]/i, detail: 'dangerous module import' },
  { regex: /\bfetch\s*\(/i, detail: 'fetch() call detected (network access)' },
  { regex: /\bXMLHttpRequest\b/i, detail: 'XMLHttpRequest reference' },
];

// ═══════════════════════════════════════════════════════
// Layer 2: Exfiltration patterns (FLAG)
// ═══════════════════════════════════════════════════════

const EXFILTRATION: { regex: RegExp; detail: string }[] = [
  { regex: /https?:\/\/[^\s"']*[?&](data|payload|token|secret|key)=/i, detail: 'URL with suspicious data parameter' },
  { regex: /\b(webhook\.site|requestbin|ngrok\.io|pipedream\.net)\b/i, detail: 'Known exfiltration endpoint' },
  { regex: /\bwindow\.location\s*=\s*['"][^'"]*\?/i, detail: 'Redirect with query parameter' },
];

// ═══════════════════════════════════════════════════════
// Layer 3: Prompt injection patterns (FLAG)
// ═══════════════════════════════════════════════════════

const INJECTION: { regex: RegExp; detail: string }[] = [
  { regex: /<!--\s*(system|override|ignore|reset|forget)\b/i, detail: 'HTML comment directive' },
  { regex: /[\u200B\u200C\u200D\uFEFF]/g, detail: 'Zero-width characters detected' },
  { regex: /\b(you are now|ignore (previous|all|above)|system:\s*override|forget (your|all))\b/i, detail: 'Role reassignment attempt' },
  { regex: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|system\|>/i, detail: 'Chat template injection' },
];

// ═══════════════════════════════════════════════════════
// Layer 4: External dependency patterns (FLAG)
// ═══════════════════════════════════════════════════════

const EXTERNAL_DEPS: { regex: RegExp; detail: string }[] = [
  { regex: /<script\s+src\s*=\s*['"]https?:\/\//i, detail: 'External CDN script tag' },
  { regex: /https?:\/\/[^\s"']*\.(?:sh|bash|ps1|bat|exe|msi|pkg|deb|rpm)\b/i, detail: 'External binary/script URL' },
  { regex: /curl\s+.*https?:\/\/[^\s"']*\s*\|\s*(bash|sh)/i, detail: 'curl-pipe-to-shell pattern' },
];

// ═══════════════════════════════════════════════════════
// Layer 5: Capability patterns (permissions check)
// ═══════════════════════════════════════════════════════

const CAPABILITIES: { regex: RegExp; capability: string }[] = [
  { regex: /\bfs\b.*\b(write|unlink|rm|mkdir|append)/i, capability: 'filesystem-write' },
  { regex: /\bprocess\.env\b/i, capability: 'env-access' },
  { regex: /\bprocess\.exit\b/i, capability: 'process-exit' },
  { regex: /\bcrypto\b/i, capability: 'crypto-access' },
  { regex: /\bdocker\b/i, capability: 'docker' },
  { regex: /\bkubectl\b/i, capability: 'kubernetes' },
];

// ═══════════════════════════════════════════════════════
// Weights per layer
// ═══════════════════════════════════════════════════════

const WEIGHT = {
  hardReject: 1.0,
  exfiltration: 0.4,
  injection: 0.3,
  externalDeps: 0.2,
  undeclaredCap: 0.15,
} as const;

function scanContent(content: string, declaredPermissions: string[] = []): ExtendedScreeningVerdict {
  const reasons: ScreeningReason[] = [];
  let score = 0;
  const detectedCapabilities: string[] = [];
  const lines = content.split('\n');

  const findLine = (regex: RegExp): number | undefined => {
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) return i + 1;
    }
    return undefined;
  };

  // Layer 1: Hard-reject
  for (const p of HARD_REJECT) {
    if (p.regex.test(content)) {
      reasons.push({ category: 'hard-reject', severity: 'BLOCK', detail: p.detail, line: findLine(p.regex) });
      score += WEIGHT.hardReject;
    }
  }

  // Layer 2: Exfiltration
  for (const p of EXFILTRATION) {
    if (p.regex.test(content)) {
      reasons.push({ category: 'exfiltration', severity: 'FLAG', detail: p.detail, line: findLine(p.regex) });
      score += WEIGHT.exfiltration;
    }
  }

  // Layer 3: Prompt injection
  for (const p of INJECTION) {
    if (p.regex.test(content)) {
      reasons.push({ category: 'prompt-injection', severity: 'FLAG', detail: p.detail, line: findLine(p.regex) });
      score += WEIGHT.injection;
    }
  }

  // Layer 4: External dependencies
  for (const p of EXTERNAL_DEPS) {
    if (p.regex.test(content)) {
      reasons.push({ category: 'external-deps', severity: 'FLAG', detail: p.detail, line: findLine(p.regex) });
      score += WEIGHT.externalDeps;
    }
  }

  // Layer 5: Undeclared capabilities
  for (const p of CAPABILITIES) {
    if (p.regex.test(content)) {
      detectedCapabilities.push(p.capability);
      if (!declaredPermissions.includes(p.capability)) {
        reasons.push({ category: 'undeclared-capability', severity: 'FLAG', detail: `Undeclared capability: ${p.capability}`, line: findLine(p.regex) });
        score += WEIGHT.undeclaredCap;
      }
    }
  }

  // Clamp score
  score = Math.min(score, 1);

  // Determine verdict
  let verdict: ScreeningVerdictKind;
  if (reasons.some(r => r.severity === 'BLOCK') || score >= 0.8) {
    verdict = 'REJECT';
  } else if (score >= 0.3) {
    verdict = 'REVIEW';
  } else {
    verdict = 'APPROVE';
  }

  const excessPermissions = declaredPermissions.filter(
    p => !detectedCapabilities.includes(p)
  );

  return {
    verdict,
    score: Math.round(score * 100) / 100,
    reasons,
    permissions: detectedCapabilities,
    excessPermissions,
  };
}

export function create(_config: Config): SkillScreenerProvider {
  return {
    async screen(content: string, declaredPermissions?: string[]): Promise<ScreeningVerdict> {
      const ext = scanContent(content, declaredPermissions);
      return {
        allowed: ext.verdict !== 'REJECT',
        reasons: ext.reasons.map(r => r.detail),
      };
    },

    async screenExtended(content: string, declaredPermissions?: string[]): Promise<ExtendedScreeningVerdict> {
      return scanContent(content, declaredPermissions);
    },

    async screenBatch(items: Array<{ content: string; declaredPermissions?: string[] }>): Promise<ExtendedScreeningVerdict[]> {
      return items.map(item => scanContent(item.content, item.declaredPermissions));
    },
  };
}
