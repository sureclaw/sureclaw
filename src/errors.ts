// src/errors.ts — Error diagnosis for user-facing error messages
//
// Maps known error patterns to human-readable diagnosis + suggestion.
// Used at every user-facing error boundary (CLI, server HTTP response).

import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DiagnosedError {
  /** Raw error message */
  raw: string;
  /** Human-readable diagnosis */
  diagnosis: string;
  /** Actionable suggestion */
  suggestion: string;
  /** Path hint to full logs */
  logHint: string;
}

interface ErrorPattern {
  test: RegExp;
  diagnosis: string;
  suggestion: string;
}

const PATTERNS: ErrorPattern[] = [
  {
    test: /ETIMEDOUT/i,
    diagnosis: 'Network timeout — could not reach the API',
    suggestion: 'Check your wifi/VPN connection and try again',
  },
  {
    test: /ECONNREFUSED/i,
    diagnosis: 'Connection refused — nothing is listening at the target address',
    suggestion: 'Is the server running? Start it with: ax serve',
  },
  {
    test: /ECONNRESET/i,
    diagnosis: 'Connection dropped mid-request',
    suggestion: 'Network instability — try again',
  },
  {
    test: /ENOTFOUND/i,
    diagnosis: 'DNS resolution failed — hostname not found',
    suggestion: 'Check your internet connection',
  },
  {
    test: /EPIPE|socket hang up|socket hangup/i,
    diagnosis: 'Connection closed unexpectedly',
    suggestion: 'Server may have crashed — check logs',
  },
  {
    test: /\b401\b.*unauthorized|authentication.?error/i,
    diagnosis: 'Authentication failed — credentials are missing or expired',
    suggestion: 'Run `ax configure` to refresh credentials',
  },
  {
    test: /\b403\b.*forbidden/i,
    diagnosis: 'Access denied — API key lacks required permissions',
    suggestion: 'Check your API key permissions at console.anthropic.com',
  },
  {
    test: /\b429\b|rate.?limit|too many requests/i,
    diagnosis: 'Rate limited by the API',
    suggestion: 'Wait a moment and try again, or check your usage limits',
  },
  {
    test: /\b50[023]\b|bad gateway|service unavailable|internal server error/i,
    diagnosis: 'Upstream API error — the service may be down',
    suggestion: 'Check status.anthropic.com for outages',
  },
  {
    test: /CERT|SSL|TLS|self.signed|unable to verify/i,
    diagnosis: 'SSL/TLS handshake failed',
    suggestion: 'Check your system clock, proxy, or firewall settings',
  },
];

function getLogHint(): string {
  const home = process.env.AX_HOME || join(homedir(), '.ax');
  return `Details: ${join(home, 'data', 'ax.log')}`;
}

export function diagnoseError(err: Error | string): DiagnosedError {
  const raw = typeof err === 'string' ? err : err.message;
  const logHint = getLogHint();

  for (const pattern of PATTERNS) {
    if (pattern.test.test(raw)) {
      return {
        raw,
        diagnosis: pattern.diagnosis,
        suggestion: pattern.suggestion,
        logHint,
      };
    }
  }

  return {
    raw,
    diagnosis: 'Unexpected error',
    suggestion: 'See log file for details',
    logHint,
  };
}

/**
 * Format a diagnosed error for user-facing display (CLI, HTTP response).
 * Single-line for server logs, multi-line for CLI.
 */
export function formatDiagnosedError(d: DiagnosedError): string {
  return `${d.diagnosis}: ${d.raw}\n${d.suggestion}\n${d.logHint}`;
}
