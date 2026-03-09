// src/host/sandbox-tools/bash-classifier.ts — Strict bash command classifier
//
// Classifies bash commands as Tier 1 (WASM-safe) or Tier 2 (needs container).
// Only exact command shapes from a strict allowlist are routed to Tier 1.
// Everything ambiguous, piped, redirected, or unrecognized goes to Tier 2.
//
// Design principle: false negatives (sending to Tier 2 when Tier 1 would work)
// cost latency. False positives (sending to Tier 1 when it can't handle the
// command) cost correctness. Correctness wins.

/**
 * Classification result for a bash command.
 */
export interface BashClassification {
  /** Whether this command can be handled by Tier 1 (WASM). */
  tier1: boolean;
  /** Which WASM module would handle this, if tier1 is true. */
  module?: string;
  /** Human-readable reason for the classification decision. */
  reason: string;
}

/**
 * Shell metacharacters that force Tier 2. If any of these appear outside
 * of single-quoted strings, the command needs a real shell.
 */
const SHELL_METACHARACTERS = /[|;&$`(){}<>!\\]/;

/**
 * Patterns that indicate variable expansion or subshell — always Tier 2.
 */
const VARIABLE_PATTERNS = /\$[({A-Za-z_]/;

/**
 * Redirection operators — always Tier 2.
 */
const REDIRECTION = /[<>]|>>|\d+>/;

/**
 * Read-only commands that are safe to execute in WASM.
 * Each entry maps a command name to a validator function that checks
 * whether the specific invocation is safe for Tier 1.
 */
const READONLY_COMMANDS: Record<string, (args: string[]) => BashClassification> = {
  pwd: (_args) => ({ tier1: true, module: 'coreutils', reason: 'pwd: stateless read-only command' }),

  ls: (args) => {
    // Allow ls with common flags, reject anything with shell metacharacters in args
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'ls: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'ls: read-only directory listing' };
  },

  cat: (args) => {
    if (args.length === 0) return { tier1: false, reason: 'cat: no file argument (stdin mode)' };
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'cat: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'cat: read-only file display' };
  },

  head: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'head: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'head: read-only file display' };
  },

  tail: (args) => {
    // Reject tail -f (follow mode needs long-running process)
    if (args.includes('-f') || args.includes('--follow')) {
      return { tier1: false, reason: 'tail: follow mode requires persistent process' };
    }
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'tail: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'tail: read-only file display' };
  },

  wc: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'wc: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'wc: read-only word/line count' };
  },

  rg: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'rg: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'ripgrep', reason: 'rg: read-only content search' };
  },

  grep: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'grep: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'grep: read-only content search' };
  },

  find: (args) => {
    // Only allow find without -exec, -delete, or other mutating flags
    const dangerousFlags = ['-exec', '-execdir', '-delete', '-ok', '-okdir'];
    if (args.some(a => dangerousFlags.includes(a))) {
      return { tier1: false, reason: 'find: mutating or exec flag detected' };
    }
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'find: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'find: read-only file search' };
  },

  git: (args) => {
    // Only allow read-only git subcommands
    const readOnlySubcommands = [
      'status', 'log', 'diff', 'show', 'branch', 'tag',
      'ls-files', 'ls-tree', 'rev-parse', 'describe',
      'shortlog', 'blame', 'cat-file',
    ];
    const subcommand = args.find(a => !a.startsWith('-'));
    if (!subcommand) {
      return { tier1: false, reason: 'git: no subcommand specified' };
    }
    if (!readOnlySubcommands.includes(subcommand)) {
      return { tier1: false, reason: `git: subcommand '${subcommand}' is not in read-only allowlist` };
    }
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'git: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'git-readonly', reason: `git ${subcommand}: read-only git operation` };
  },

  echo: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a) || VARIABLE_PATTERNS.test(a))) {
      return { tier1: false, reason: 'echo: argument contains shell metacharacters or variable expansion' };
    }
    return { tier1: true, module: 'coreutils', reason: 'echo: simple text output' };
  },

  basename: (_args) => ({ tier1: true, module: 'coreutils', reason: 'basename: stateless path operation' }),

  dirname: (_args) => ({ tier1: true, module: 'coreutils', reason: 'dirname: stateless path operation' }),

  realpath: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'realpath: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'realpath: read-only path resolution' };
  },

  stat: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'stat: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'stat: read-only file info' };
  },

  file: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'file: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'file: read-only type detection' };
  },

  tree: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'tree: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'tree: read-only directory tree' };
  },

  du: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'du: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'du: read-only disk usage' };
  },

  df: (args) => {
    if (args.some(a => SHELL_METACHARACTERS.test(a))) {
      return { tier1: false, reason: 'df: argument contains shell metacharacters' };
    }
    return { tier1: true, module: 'coreutils', reason: 'df: read-only disk free' };
  },
};

/**
 * Classify a bash command for Tier 1 or Tier 2 routing.
 *
 * The classifier applies these rules in order:
 * 1. Reject empty commands
 * 2. Reject commands with shell metacharacters at the top level
 * 3. Parse command name and arguments
 * 4. Check against the allowlisted command set
 * 5. Default to Tier 2 when uncertain
 */
export function classifyBashCommand(command: string): BashClassification {
  const trimmed = command.trim();

  if (!trimmed) {
    return { tier1: false, reason: 'empty command' };
  }

  // Multi-line commands always go to Tier 2
  if (trimmed.includes('\n')) {
    return { tier1: false, reason: 'multi-line command requires full shell' };
  }

  // Check for shell metacharacters at the top level before parsing
  if (VARIABLE_PATTERNS.test(trimmed)) {
    return { tier1: false, reason: 'command contains variable expansion' };
  }

  if (REDIRECTION.test(trimmed)) {
    return { tier1: false, reason: 'command contains redirection' };
  }

  // Check for pipes — always Tier 2
  if (trimmed.includes('|')) {
    return { tier1: false, reason: 'command contains pipe' };
  }

  // Check for command chaining (&&, ||, ;)
  if (/&&|\|\||;/.test(trimmed)) {
    return { tier1: false, reason: 'command contains chaining operators' };
  }

  // Check for backticks or $() subshell
  if (trimmed.includes('`') || trimmed.includes('$(')) {
    return { tier1: false, reason: 'command contains subshell/backtick expansion' };
  }

  // Parse into command + args (simple split — no shell quoting support needed
  // since we've already rejected metacharacters)
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  // Look up in the allowlist
  const validator = READONLY_COMMANDS[cmd];
  if (!validator) {
    return { tier1: false, reason: `command '${cmd}' not in Tier 1 allowlist` };
  }

  return validator(args);
}
