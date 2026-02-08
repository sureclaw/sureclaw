import { randomBytes } from 'node:crypto';
import type { ScannerProvider, ScanTarget, ScanResult, Config } from './types.js';

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system\s*prompt/i,
  /\bDAN\b.*\bjailbreak/i,
  /do\s+anything\s+now/i,
  /act\s+as\s+(if\s+)?you\s+(are|were)\s+/i,
  /pretend\s+(you\s+are|to\s+be)\s+/i,
  /override\s+(your|the)\s+(safety|instructions|rules)/i,
  /bypass\s+(your|the|all)\s+(restrictions|filters|safety)/i,
  /\[\s*SYSTEM\s*\]/i,
  /```\s*system/i,
  /<\/?system>/i,
  /\bbase64_decode\b/i,
  /\beval\s*\(/i,
];

const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,           // SSN
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // credit card
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // email (loose)
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

      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(msg.content)) {
          matched.push(pattern.source);
        }
      }

      if (matched.length > 0) {
        return {
          verdict: 'BLOCK',
          reason: `Prompt injection pattern detected`,
          patterns: matched,
        };
      }

      return { verdict: 'PASS' };
    },

    async scanOutput(msg: ScanTarget): Promise<ScanResult> {
      const matched: string[] = [];

      for (const pattern of PII_PATTERNS) {
        if (pattern.test(msg.content)) {
          matched.push(pattern.source);
        }
      }

      if (matched.length > 0) {
        return {
          verdict: 'FLAG',
          reason: 'Potential PII detected in output',
          patterns: matched,
        };
      }

      return { verdict: 'PASS' };
    },
  };
}
