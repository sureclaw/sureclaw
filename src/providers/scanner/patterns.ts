import { randomBytes } from 'node:crypto';
import type { ScannerProvider, ScanTarget, ScanResult, Config } from '../types.js';

interface Pattern {
  regex: RegExp;
  category: string;
  severity: 'INFO' | 'FLAG' | 'BLOCK';
}

// ═══════════════════════════════════════════════════════
// Input patterns (prompt injection / jailbreak)
// ═══════════════════════════════════════════════════════

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

  // Code execution
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

// ═══════════════════════════════════════════════════════
// Output patterns (PII, credentials, sensitive data)
// ═══════════════════════════════════════════════════════

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

export async function create(_config: Config): Promise<ScannerProvider> {
  return {
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
  };
}
