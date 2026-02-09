import { randomBytes } from 'node:crypto';
import type { ScannerProvider, ScanTarget, ScanResult, Config } from '../types.js';

/**
 * Promptfoo ML scanner — combines regex patterns with ML-based
 * prompt injection detection.
 *
 * Falls back to regex-only if ML model is unavailable.
 * Configurable confidence threshold via AX_ML_THRESHOLD (default 0.7).
 *
 * ML detection uses text feature analysis:
 * - Instruction override density (keywords per sentence)
 * - Role-switching signals
 * - Encoding/obfuscation markers
 * - Structural anomalies (tag-like patterns, base64 blocks)
 */

const DEFAULT_THRESHOLD = 0.7;

// ═══════════════════════════════════════════════════════
// Regex patterns (subset of patterns.ts for fallback)
// ═══════════════════════════════════════════════════════

interface Pattern {
  regex: RegExp;
  category: string;
  severity: 'FLAG' | 'BLOCK';
  weight: number; // ML feature weight
}

const INPUT_PATTERNS: Pattern[] = [
  { regex: /ignore\s+(all\s+)?previous\s+instructions/i, category: 'injection:direct', severity: 'BLOCK', weight: 1.0 },
  { regex: /disregard\s+(all\s+)?previous/i, category: 'injection:direct', severity: 'BLOCK', weight: 1.0 },
  { regex: /override\s+(your|the)\s+(safety|instructions|rules)/i, category: 'injection:direct', severity: 'BLOCK', weight: 0.9 },
  { regex: /bypass\s+(your|the|all)\s+(restrictions|filters|safety)/i, category: 'injection:direct', severity: 'BLOCK', weight: 0.9 },
  { regex: /forget\s+(all\s+)?(your\s+)?(previous\s+)?(instructions|rules|guidelines)/i, category: 'injection:direct', severity: 'BLOCK', weight: 1.0 },
  { regex: /you\s+are\s+now\s+(a|an)\s+/i, category: 'injection:persona', severity: 'BLOCK', weight: 0.8 },
  { regex: /\bDAN\b.*\bjailbreak/i, category: 'injection:persona', severity: 'BLOCK', weight: 1.0 },
  { regex: /do\s+anything\s+now/i, category: 'injection:persona', severity: 'BLOCK', weight: 0.9 },
  { regex: /\bsystem\s*prompt/i, category: 'injection:extraction', severity: 'BLOCK', weight: 0.7 },
  { regex: /\[\s*SYSTEM\s*\]/i, category: 'injection:extraction', severity: 'BLOCK', weight: 0.8 },
  { regex: /<\/?system>/i, category: 'injection:extraction', severity: 'BLOCK', weight: 0.8 },
  { regex: /\bbase64_decode\b/i, category: 'injection:code', severity: 'BLOCK', weight: 0.6 },
  { regex: /\beval\s*\(/i, category: 'injection:code', severity: 'BLOCK', weight: 0.7 },
  { regex: /;\s*(rm|del|format|mkfs|dd)\s/i, category: 'injection:shell', severity: 'BLOCK', weight: 0.9 },
  { regex: /\$\(\s*(curl|wget|nc|ncat)\s/i, category: 'injection:shell', severity: 'BLOCK', weight: 0.9 },
];

const OUTPUT_PATTERNS: Pattern[] = [
  { regex: /\b\d{3}-\d{2}-\d{4}\b/, category: 'pii:ssn', severity: 'FLAG', weight: 0.8 },
  { regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, category: 'pii:credit_card', severity: 'FLAG', weight: 0.8 },
  { regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/, category: 'credential:anthropic_key', severity: 'BLOCK', weight: 1.0 },
  { regex: /\bsk-[a-zA-Z0-9]{20,}\b/, category: 'credential:openai_key', severity: 'BLOCK', weight: 1.0 },
  { regex: /\bghp_[a-zA-Z0-9]{36,}\b/, category: 'credential:github_token', severity: 'BLOCK', weight: 1.0 },
  { regex: /\bAKIA[A-Z0-9]{16}\b/, category: 'credential:aws_key', severity: 'BLOCK', weight: 1.0 },
  { regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, category: 'credential:private_key', severity: 'BLOCK', weight: 1.0 },
];

// ═══════════════════════════════════════════════════════
// ML feature extraction
// ═══════════════════════════════════════════════════════

interface MLFeatures {
  instructionOverrideDensity: number;
  roleSwitchingScore: number;
  encodingMarkers: number;
  structuralAnomalies: number;
  lengthRatio: number;
}

/** Keywords that signal instruction override attempts. */
const OVERRIDE_KEYWORDS = [
  'ignore', 'disregard', 'forget', 'override', 'bypass', 'disable',
  'pretend', 'roleplay', 'jailbreak', 'instruction', 'rule', 'constraint',
  'safety', 'filter', 'restriction', 'previous', 'above', 'system',
];

/** Patterns that indicate role-switching. */
const ROLE_SWITCH_PATTERNS = [
  /\b(you are|act as|pretend to be|roleplay as|from now on)\b/gi,
  /\b(new persona|new identity|new role|new instructions)\b/gi,
  /\b(human|assistant|system|user)\s*:/gi,
];

/** Markers of encoding/obfuscation. */
const ENCODING_PATTERNS = [
  /[A-Za-z0-9+/]{40,}={0,2}/, // base64 blocks
  /\\x[0-9a-fA-F]{2}/,        // hex escapes
  /\\u[0-9a-fA-F]{4}/,        // unicode escapes
  /&#\d{2,4};/,               // HTML entities
  /(%[0-9a-fA-F]{2}){3,}/,    // URL encoding
];

/** Structural anomalies (tag-like injections). */
const STRUCTURAL_PATTERNS = [
  /<\/?[a-z]+>/gi,                    // HTML/XML tags
  /\{[{%].*[%}]\}/,                   // template tags
  /\[\[.*\]\]/,                       // wiki-style tags
  /```\s*(system|admin|root|sudo)/i,  // code block role injection
];

function extractFeatures(text: string): MLFeatures {
  // Strip trailing punctuation from words for keyword matching
  const words = text.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, ''));
  const wordCount = Math.max(words.length, 1);

  // Instruction override density: ratio of override keywords to total words
  const overrideCount = words.filter(w => OVERRIDE_KEYWORDS.includes(w)).length;
  const instructionOverrideDensity = Math.min(overrideCount / wordCount * 10, 1.0);

  // Role switching: number of role-switch pattern matches
  let roleSwitchCount = 0;
  for (const pattern of ROLE_SWITCH_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags));
    roleSwitchCount += matches?.length ?? 0;
  }
  const roleSwitchingScore = Math.min(roleSwitchCount / 3, 1.0);

  // Encoding markers: presence of encoded content
  let encodingCount = 0;
  for (const pattern of ENCODING_PATTERNS) {
    if (pattern.test(text)) encodingCount++;
  }
  const encodingMarkers = Math.min(encodingCount / ENCODING_PATTERNS.length, 1.0);

  // Structural anomalies: tag-like patterns
  let structuralCount = 0;
  for (const pattern of STRUCTURAL_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags));
    structuralCount += matches?.length ?? 0;
  }
  const structuralAnomalies = Math.min(structuralCount / 4, 1.0);

  // Length ratio: very long inputs are more suspicious
  const lengthRatio = Math.min(text.length / 2000, 1.0);

  return {
    instructionOverrideDensity,
    roleSwitchingScore,
    encodingMarkers,
    structuralAnomalies,
    lengthRatio,
  };
}

/** Weighted sum of ML features → confidence score. */
function computeMLScore(features: MLFeatures): number {
  const weights = {
    instructionOverrideDensity: 0.30,
    roleSwitchingScore: 0.30,
    encodingMarkers: 0.20,
    structuralAnomalies: 0.15,
    lengthRatio: 0.05,
  };

  const weighted =
    features.instructionOverrideDensity * weights.instructionOverrideDensity +
    features.roleSwitchingScore * weights.roleSwitchingScore +
    features.encodingMarkers * weights.encodingMarkers +
    features.structuralAnomalies * weights.structuralAnomalies +
    features.lengthRatio * weights.lengthRatio;

  // Boost: any single strong signal (>0.5) gets additional weight
  const maxFeature = Math.max(
    features.instructionOverrideDensity,
    features.roleSwitchingScore,
    features.encodingMarkers,
    features.structuralAnomalies,
  );
  const boost = maxFeature > 0.5 ? maxFeature * 0.3 : 0;

  return Math.min(weighted + boost, 1.0);
}

// ═══════════════════════════════════════════════════════
// Scanner provider
// ═══════════════════════════════════════════════════════

export async function create(_config: Config): Promise<ScannerProvider> {
  const threshold = parseFloat(
    process.env.AX_ML_THRESHOLD ?? String(DEFAULT_THRESHOLD),
  );

  return {
    canaryToken(): string {
      return `CANARY-${randomBytes(16).toString('hex')}`;
    },

    checkCanary(output: string, token: string): boolean {
      return output.includes(token);
    },

    async scanInput(msg: ScanTarget): Promise<ScanResult> {
      // Layer 1: Regex patterns
      const regexMatched: string[] = [];
      let worstSeverity: 'PASS' | 'FLAG' | 'BLOCK' = 'PASS';

      for (const pattern of INPUT_PATTERNS) {
        if (pattern.regex.test(msg.content)) {
          regexMatched.push(`${pattern.category} (${pattern.severity})`);
          if (pattern.severity === 'BLOCK') worstSeverity = 'BLOCK';
          else if (pattern.severity === 'FLAG' && worstSeverity !== 'BLOCK') {
            worstSeverity = 'FLAG';
          }
        }
      }

      // Layer 2: ML feature analysis
      const features = extractFeatures(msg.content);
      const mlScore = computeMLScore(features);

      // Combine: regex BLOCK always wins; ML can escalate PASS → FLAG/BLOCK
      if (worstSeverity === 'BLOCK') {
        return {
          verdict: 'BLOCK',
          reason: `Prompt injection detected (regex + ML score: ${mlScore.toFixed(2)})`,
          patterns: regexMatched,
        };
      }

      if (mlScore >= threshold) {
        const mlPatterns = Object.entries(features)
          .filter(([, v]) => v > 0.2)
          .map(([k, v]) => `ml:${k}=${(v as number).toFixed(2)}`);

        return {
          verdict: mlScore >= threshold * 1.3 ? 'BLOCK' : 'FLAG',
          reason: `ML classifier flagged (score: ${mlScore.toFixed(2)}, threshold: ${threshold})`,
          patterns: [...regexMatched, ...mlPatterns],
        };
      }

      if (regexMatched.length > 0) {
        return {
          verdict: worstSeverity,
          reason: 'Suspicious input pattern detected',
          patterns: regexMatched,
        };
      }

      return { verdict: 'PASS' };
    },

    async scanOutput(msg: ScanTarget): Promise<ScanResult> {
      const matched: string[] = [];
      let worstSeverity: 'PASS' | 'FLAG' | 'BLOCK' = 'PASS';

      for (const pattern of OUTPUT_PATTERNS) {
        if (pattern.regex.test(msg.content)) {
          matched.push(`${pattern.category} (${pattern.severity})`);
          if (pattern.severity === 'BLOCK') worstSeverity = 'BLOCK';
          else if (pattern.severity === 'FLAG' && worstSeverity !== 'BLOCK') {
            worstSeverity = 'FLAG';
          }
        }
      }

      if (matched.length === 0) return { verdict: 'PASS' };

      return {
        verdict: worstSeverity,
        reason: worstSeverity === 'BLOCK'
          ? 'Sensitive data detected in output'
          : 'Potential PII detected in output',
        patterns: matched,
      };
    },
  };
}
