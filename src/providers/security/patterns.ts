/**
 * Pattern-based security provider — merged scanner + screener.
 *
 * Scanner layer: regex-based input/output scanning for injection attacks,
 * credential leaks, PII, and canary token management.
 *
 * Screener layer: 5-layer static content analyzer for skill screening.
 *   1. Hard-reject: exec, eval, spawn, child_process, base64 -> BLOCK
 *   2. Exfiltration: URLs with data params, webhooks, ngrok -> FLAG
 *   3. Prompt injection: HTML comment overrides, zero-width chars -> FLAG
 *   4. External dependencies: CDN scripts, external binary URLs -> FLAG
 *   5. Permission manifest: undeclared capabilities -> FLAG
 *
 * Scoring: Any BLOCK -> REJECT. Score >= 0.8 -> REJECT. >= 0.3 -> REVIEW. Else APPROVE.
 */

import { randomBytes } from 'node:crypto';
import type {
  SecurityProvider,
  ScanTarget,
  ScanResult,
  ScreeningVerdict,
  ExtendedScreeningVerdict,
  ScreeningReason,
  ScreeningVerdictKind,
} from './types.js';
import type { Config } from '../../types.js';

// ═══════════════════════════════════════════════════════
// Scanner patterns
// ═══════════════════════════════════════════════════════

interface Pattern {
  regex: RegExp;
  category: string;
  severity: 'INFO' | 'FLAG' | 'BLOCK';
}

// Input patterns (prompt injection / jailbreak)
const INPUT_PATTERNS: Pattern[] = [
  // Direct injection
  { regex: /ignore\s+(all\s+)?previous\s+instructions/i, category: 'injection:direct', severity: 'BLOCK' },
  { regex: /disregard\s+(all\s+)?previous/i, category: 'injection:direct', severity: 'BLOCK' },
  { regex: /override\s+(your|the)\s+(safety|instructions|rules)/i, category: 'injection:direct', severity: 'BLOCK' },
  { regex: /bypass\s+(your|the|all)\s+(restrictions|filters|safety)/i, category: 'injection:direct', severity: 'BLOCK' },
  { regex: /forget\s+(all\s+)?(your\s+)?(previous\s+)?(instructions|rules|guidelines)/i, category: 'injection:direct', severity: 'BLOCK' },

  // Persona / jailbreak
  { regex: /you\s+are\s+now\s+(a|an)\s+/i, category: 'injection:persona', severity: 'BLOCK' },
  { regex: /\bDAN\b.*\bjailbreak/i, category: 'injection:persona', severity: 'BLOCK' },
  { regex: /do\s+anything\s+now/i, category: 'injection:persona', severity: 'BLOCK' },
  { regex: /act\s+as\s+(if\s+)?you\s+(are|were)\s+/i, category: 'injection:persona', severity: 'FLAG' },
  { regex: /pretend\s+(you\s+are|to\s+be)\s+/i, category: 'injection:persona', severity: 'FLAG' },

  // System prompt extraction
  { regex: /\bsystem\s*prompt/i, category: 'injection:extraction', severity: 'BLOCK' },
  { regex: /\[\s*SYSTEM\s*\]/i, category: 'injection:extraction', severity: 'BLOCK' },
  { regex: /```\s*system/i, category: 'injection:extraction', severity: 'BLOCK' },
  { regex: /<\/?system>/i, category: 'injection:extraction', severity: 'BLOCK' },
  { regex: /repeat\s+(your|the)\s+(system|initial)\s+(message|prompt|instructions)/i, category: 'injection:extraction', severity: 'BLOCK' },
  { regex: /what\s+(are|were)\s+your\s+(initial|original|first)\s+instructions/i, category: 'injection:extraction', severity: 'FLAG' },

  // Code execution — these regexes DETECT dangerous patterns, they don't execute them
  { regex: /\bbase64_decode\b/i, category: 'injection:code', severity: 'BLOCK' },
  { regex: /\beval\s*\(/i, category: 'injection:code', severity: 'BLOCK' },
  { regex: /\bexec\s*\(/i, category: 'injection:code', severity: 'FLAG' },

  // Shell injection
  { regex: /;\s*(rm|del|format|mkfs|dd)\s/i, category: 'injection:shell', severity: 'BLOCK' },
  { regex: /\$\(\s*(curl|wget|nc|ncat)\s/i, category: 'injection:shell', severity: 'BLOCK' },
  { regex: /\|\s*(bash|sh|zsh|cmd|powershell)/i, category: 'injection:shell', severity: 'BLOCK' },
  { regex: /`\s*(curl|wget|nc)\s/i, category: 'injection:shell', severity: 'BLOCK' },

  // Exfiltration attempt
  { regex: /send\s+.{0,30}(data|information|credentials|keys|tokens)\s+to/i, category: 'exfiltration', severity: 'BLOCK' },
  { regex: /upload\s+.{0,20}(data|file|content)\s+to/i, category: 'exfiltration', severity: 'FLAG' },
  { regex: /fetch\s+https?:\/\/\S+[?&](key|token|password|secret)=/i, category: 'exfiltration', severity: 'BLOCK' },
];

// Output patterns (PII, credentials, sensitive data)
const OUTPUT_PATTERNS: Pattern[] = [
  // PII
  { regex: /\b\d{3}-\d{2}-\d{4}\b/, category: 'pii:ssn', severity: 'FLAG' },
  { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, category: 'pii:credit_card', severity: 'FLAG' },
  { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, category: 'pii:email', severity: 'INFO' },
  { regex: /\b\d{3}[-.)\s]?\d{3}[-.)\s]?\d{4}\b/, category: 'pii:phone', severity: 'INFO' },

  // Credentials in output (agent should never leak these)
  { regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/, category: 'credential:anthropic_key', severity: 'BLOCK' },
  { regex: /\bsk-[a-zA-Z0-9]{20,}\b/, category: 'credential:openai_key', severity: 'BLOCK' },
  { regex: /\bghp_[a-zA-Z0-9]{36,}\b/, category: 'credential:github_token', severity: 'BLOCK' },
  { regex: /\bAKIA[A-Z0-9]{16}\b/, category: 'credential:aws_key', severity: 'BLOCK' },
  { regex: /\bxoxb-[0-9]{10,}-[a-zA-Z0-9]+\b/, category: 'credential:slack_token', severity: 'BLOCK' },
  { regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, category: 'credential:private_key', severity: 'BLOCK' },

  // Secrets in structured output
  { regex: /"(password|secret|token|api_key|apikey)"\s*:\s*"[^"]{8,}"/i, category: 'credential:json_secret', severity: 'FLAG' },
  { regex: /(PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*[^\s]{8,}/i, category: 'credential:env_secret', severity: 'FLAG' },
];

// ═══════════════════════════════════════════════════════
// Screener patterns (5-layer skill content analysis)
// ═══════════════════════════════════════════════════════

// Layer 1: Hard-reject patterns (BLOCK)
// NOTE: These regexes DETECT dangerous code patterns in skill content.
// They do not execute anything.
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

// Layer 2: Exfiltration patterns (FLAG)
const SCREEN_EXFILTRATION: { regex: RegExp; detail: string }[] = [
  { regex: /https?:\/\/[^\s"']*[?&](data|payload|token|secret|key)=/i, detail: 'URL with suspicious data parameter' },
  { regex: /\b(webhook\.site|requestbin|ngrok\.io|pipedream\.net)\b/i, detail: 'Known exfiltration endpoint' },
  { regex: /\bwindow\.location\s*=\s*['"][^'"]*\?/i, detail: 'Redirect with query parameter' },
];

// Layer 3: Prompt injection patterns (FLAG)
const SCREEN_INJECTION: { regex: RegExp; detail: string }[] = [
  { regex: /<!--\s*(system|override|ignore|reset|forget)\b/i, detail: 'HTML comment directive' },
  { regex: /[\u200B\u200C\u200D\uFEFF]/, detail: 'Zero-width characters detected' },
  { regex: /\b(you are now|ignore (previous|all|above)|system:\s*override|forget (your|all))\b/i, detail: 'Role reassignment attempt' },
  { regex: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|system\|>/i, detail: 'Chat template injection' },
];

// Layer 4: External dependency patterns (FLAG)
const EXTERNAL_DEPS: { regex: RegExp; detail: string }[] = [
  { regex: /<script\s+src\s*=\s*['"]https?:\/\//i, detail: 'External CDN script tag' },
  { regex: /https?:\/\/[^\s"']*\.(?:sh|bash|ps1|bat|exe|msi|pkg|deb|rpm)\b/i, detail: 'External binary/script URL' },
  { regex: /curl\s+.*https?:\/\/[^\s"']*\s*\|\s*(bash|sh)/i, detail: 'curl-pipe-to-shell pattern' },
];

// Layer 5: Capability patterns (permissions check)
const CAPABILITIES: { regex: RegExp; capability: string }[] = [
  { regex: /\bfs\b.*\b(write|unlink|rm|mkdir|append)/i, capability: 'filesystem-write' },
  { regex: /\bprocess\.env\b/i, capability: 'env-access' },
  { regex: /\bprocess\.exit\b/i, capability: 'process-exit' },
  { regex: /\bcrypto\b/i, capability: 'crypto-access' },
  { regex: /\bdocker\b/i, capability: 'docker' },
  { regex: /\bkubectl\b/i, capability: 'kubernetes' },
];

// Weights per layer
const WEIGHT = {
  hardReject: 1.0,
  exfiltration: 0.4,
  injection: 0.3,
  externalDeps: 0.2,
  undeclaredCap: 0.15,
} as const;

// ═══════════════════════════════════════════════════════
// Screener implementation
// ═══════════════════════════════════════════════════════

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
  for (const p of SCREEN_EXFILTRATION) {
    if (p.regex.test(content)) {
      reasons.push({ category: 'exfiltration', severity: 'FLAG', detail: p.detail, line: findLine(p.regex) });
      score += WEIGHT.exfiltration;
    }
  }

  // Layer 3: Prompt injection
  for (const p of SCREEN_INJECTION) {
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

// ═══════════════════════════════════════════════════════
// Provider factory
// ═══════════════════════════════════════════════════════

export async function create(_config: Config): Promise<SecurityProvider> {
  return {
    // ── Scanner methods ──

    canaryToken(): string {
      return `CANARY-${randomBytes(16).toString('hex')}`;
    },

    checkCanary(output: string, token: string): boolean {
      return output.includes(token);
    },

    async scanInput(msg: ScanTarget): Promise<ScanResult> {
      const matched: string[] = [];
      let worstSeverity: 'PASS' | 'FLAG' | 'BLOCK' = 'PASS';

      for (const pattern of INPUT_PATTERNS) {
        if (pattern.regex.test(msg.content)) {
          matched.push(`${pattern.category} (${pattern.severity})`);
          if (pattern.severity === 'BLOCK') {
            worstSeverity = 'BLOCK';
          } else if (pattern.severity === 'FLAG' && worstSeverity !== 'BLOCK') {
            worstSeverity = 'FLAG';
          }
        }
      }

      if (matched.length === 0) {
        return { verdict: 'PASS' };
      }

      return {
        verdict: worstSeverity,
        reason: worstSeverity === 'BLOCK'
          ? 'Prompt injection pattern detected'
          : 'Suspicious input pattern detected',
        patterns: matched,
      };
    },

    async scanOutput(msg: ScanTarget): Promise<ScanResult> {
      const matched: string[] = [];
      let worstSeverity: 'PASS' | 'FLAG' | 'BLOCK' = 'PASS';

      for (const pattern of OUTPUT_PATTERNS) {
        if (pattern.regex.test(msg.content)) {
          matched.push(`${pattern.category} (${pattern.severity})`);
          if (pattern.severity === 'BLOCK') {
            worstSeverity = 'BLOCK';
          } else if (pattern.severity === 'FLAG' && worstSeverity !== 'BLOCK') {
            worstSeverity = 'FLAG';
          }
        }
      }

      if (matched.length === 0) {
        return { verdict: 'PASS' };
      }

      return {
        verdict: worstSeverity,
        reason: worstSeverity === 'BLOCK'
          ? 'Sensitive data detected in output'
          : 'Potential PII detected in output',
        patterns: matched,
      };
    },

    // ── Screener methods ──

    async screen(content: string, declaredPermissions?: string[]): Promise<ScreeningVerdict> {
      const ext = scanContent(content, declaredPermissions);
      return {
        allowed: ext.verdict === 'APPROVE',
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
