import { describe, test, expect } from 'vitest';
import { classifyBashCommand } from '../../../src/host/sandbox-tools/bash-classifier.js';

describe('BashClassifier', () => {
  // ── Tier 1 allowlisted commands ──

  describe('allowlisted read-only commands', () => {
    test('pwd', () => {
      const r = classifyBashCommand('pwd');
      expect(r.tier1).toBe(true);
      expect(r.module).toBe('coreutils');
    });

    test('ls', () => {
      const r = classifyBashCommand('ls');
      expect(r.tier1).toBe(true);
      expect(r.module).toBe('coreutils');
    });

    test('ls -la', () => {
      const r = classifyBashCommand('ls -la');
      expect(r.tier1).toBe(true);
    });

    test('ls src/host', () => {
      const r = classifyBashCommand('ls src/host');
      expect(r.tier1).toBe(true);
    });

    test('cat file.txt', () => {
      const r = classifyBashCommand('cat file.txt');
      expect(r.tier1).toBe(true);
      expect(r.module).toBe('coreutils');
    });

    test('head -n 20 file.txt', () => {
      const r = classifyBashCommand('head -n 20 file.txt');
      expect(r.tier1).toBe(true);
    });

    test('tail -n 10 file.txt', () => {
      const r = classifyBashCommand('tail -n 10 file.txt');
      expect(r.tier1).toBe(true);
    });

    test('wc -l file.txt', () => {
      const r = classifyBashCommand('wc -l file.txt');
      expect(r.tier1).toBe(true);
    });

    test('rg pattern src/', () => {
      const r = classifyBashCommand('rg pattern src/');
      expect(r.tier1).toBe(true);
      expect(r.module).toBe('ripgrep');
    });

    test('grep -r pattern .', () => {
      const r = classifyBashCommand('grep -r pattern .');
      expect(r.tier1).toBe(true);
    });

    test('find . -name "*.ts"', () => {
      const r = classifyBashCommand('find . -name "*.ts"');
      expect(r.tier1).toBe(true);
    });

    test('echo hello', () => {
      const r = classifyBashCommand('echo hello');
      expect(r.tier1).toBe(true);
    });

    test('basename /foo/bar.txt', () => {
      const r = classifyBashCommand('basename /foo/bar.txt');
      expect(r.tier1).toBe(true);
    });

    test('dirname /foo/bar.txt', () => {
      const r = classifyBashCommand('dirname /foo/bar.txt');
      expect(r.tier1).toBe(true);
    });

    test('stat file.txt', () => {
      const r = classifyBashCommand('stat file.txt');
      expect(r.tier1).toBe(true);
    });

    test('tree src/', () => {
      const r = classifyBashCommand('tree src/');
      expect(r.tier1).toBe(true);
    });

    test('du -sh .', () => {
      const r = classifyBashCommand('du -sh .');
      expect(r.tier1).toBe(true);
    });
  });

  // ── Git read-only subcommands ──

  describe('git read-only subcommands', () => {
    test('git status', () => {
      const r = classifyBashCommand('git status');
      expect(r.tier1).toBe(true);
      expect(r.module).toBe('git-readonly');
    });

    test('git log --oneline -10', () => {
      const r = classifyBashCommand('git log --oneline -10');
      expect(r.tier1).toBe(true);
      expect(r.module).toBe('git-readonly');
    });

    test('git diff', () => {
      const r = classifyBashCommand('git diff');
      expect(r.tier1).toBe(true);
    });

    test('git show HEAD', () => {
      const r = classifyBashCommand('git show HEAD');
      expect(r.tier1).toBe(true);
    });

    test('git branch -a', () => {
      const r = classifyBashCommand('git branch -a');
      expect(r.tier1).toBe(true);
    });

    test('git ls-files', () => {
      const r = classifyBashCommand('git ls-files');
      expect(r.tier1).toBe(true);
    });

    test('git rev-parse HEAD', () => {
      const r = classifyBashCommand('git rev-parse HEAD');
      expect(r.tier1).toBe(true);
    });

    test('git blame file.ts', () => {
      const r = classifyBashCommand('git blame file.ts');
      expect(r.tier1).toBe(true);
    });
  });

  // ── Git write subcommands — must be Tier 2 ──

  describe('git write subcommands (Tier 2)', () => {
    test('git commit', () => {
      const r = classifyBashCommand('git commit -m "fix"');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('not in read-only allowlist');
    });

    test('git push', () => {
      const r = classifyBashCommand('git push origin main');
      expect(r.tier1).toBe(false);
    });

    test('git checkout', () => {
      const r = classifyBashCommand('git checkout -b feature');
      expect(r.tier1).toBe(false);
    });

    test('git merge', () => {
      const r = classifyBashCommand('git merge feature');
      expect(r.tier1).toBe(false);
    });

    test('git rebase', () => {
      const r = classifyBashCommand('git rebase main');
      expect(r.tier1).toBe(false);
    });

    test('git reset', () => {
      const r = classifyBashCommand('git reset --hard HEAD~1');
      expect(r.tier1).toBe(false);
    });

    test('git add', () => {
      const r = classifyBashCommand('git add .');
      expect(r.tier1).toBe(false);
    });
  });

  // ── Shell metacharacters and operators — must be Tier 2 ──

  describe('shell metacharacters (Tier 2)', () => {
    test('pipe', () => {
      const r = classifyBashCommand('cat file.txt | grep pattern');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('pipe');
    });

    test('redirect output', () => {
      const r = classifyBashCommand('echo hello > file.txt');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('redirection');
    });

    test('redirect input', () => {
      const r = classifyBashCommand('cat < file.txt');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('redirection');
    });

    test('append redirect', () => {
      const r = classifyBashCommand('echo hello >> file.txt');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('redirection');
    });

    test('command chaining with &&', () => {
      const r = classifyBashCommand('ls && echo done');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('chaining');
    });

    test('command chaining with ;', () => {
      const r = classifyBashCommand('ls; echo done');
      expect(r.tier1).toBe(false);
    });

    test('command chaining with ||', () => {
      const r = classifyBashCommand('ls || echo failed');
      expect(r.tier1).toBe(false);
    });

    test('variable expansion', () => {
      const r = classifyBashCommand('echo $HOME');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('variable');
    });

    test('command substitution $()', () => {
      const r = classifyBashCommand('echo $(date)');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('variable');
    });

    test('backtick substitution', () => {
      const r = classifyBashCommand('echo `date`');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('subshell');
    });

    test('background job', () => {
      const r = classifyBashCommand('sleep 10 &');
      expect(r.tier1).toBe(false);
    });

    test('subshell with parens', () => {
      const r = classifyBashCommand('(cd src && ls)');
      expect(r.tier1).toBe(false);
    });

    test('multi-line command', () => {
      const r = classifyBashCommand('echo hello\necho world');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('multi-line');
    });
  });

  // ── Commands not in allowlist ──

  describe('commands not in allowlist (Tier 2)', () => {
    test('npm test', () => {
      const r = classifyBashCommand('npm test');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('not in Tier 1 allowlist');
    });

    test('npm install', () => {
      const r = classifyBashCommand('npm install express');
      expect(r.tier1).toBe(false);
    });

    test('rm file', () => {
      const r = classifyBashCommand('rm file.txt');
      expect(r.tier1).toBe(false);
    });

    test('mv file', () => {
      const r = classifyBashCommand('mv old.txt new.txt');
      expect(r.tier1).toBe(false);
    });

    test('cp file', () => {
      const r = classifyBashCommand('cp old.txt new.txt');
      expect(r.tier1).toBe(false);
    });

    test('python script', () => {
      const r = classifyBashCommand('python script.py');
      expect(r.tier1).toBe(false);
    });

    test('node script', () => {
      const r = classifyBashCommand('node index.js');
      expect(r.tier1).toBe(false);
    });

    test('curl', () => {
      const r = classifyBashCommand('curl https://example.com');
      expect(r.tier1).toBe(false);
    });

    test('wget', () => {
      const r = classifyBashCommand('wget https://example.com');
      expect(r.tier1).toBe(false);
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    test('empty command', () => {
      const r = classifyBashCommand('');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('empty');
    });

    test('whitespace-only command', () => {
      const r = classifyBashCommand('   ');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('empty');
    });

    test('cat without arguments (stdin mode)', () => {
      const r = classifyBashCommand('cat');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('stdin');
    });

    test('tail -f (follow mode)', () => {
      const r = classifyBashCommand('tail -f logfile');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('follow');
    });

    test('tail --follow', () => {
      const r = classifyBashCommand('tail --follow logfile');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('follow');
    });

    test('find with -exec', () => {
      const r = classifyBashCommand('find . -name "*.ts" -exec rm {} +');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('exec');
    });

    test('find with -delete', () => {
      const r = classifyBashCommand('find . -name "*.tmp" -delete');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('mutating');
    });

    test('git with no subcommand', () => {
      const r = classifyBashCommand('git');
      expect(r.tier1).toBe(false);
      expect(r.reason).toContain('no subcommand');
    });

    test('git with flags before subcommand', () => {
      const r = classifyBashCommand('git --no-pager log');
      expect(r.tier1).toBe(true);
      expect(r.module).toBe('git-readonly');
    });

    test('reason string always present', () => {
      const commands = ['pwd', 'npm test', 'cat | grep', '', 'git commit -m "x"'];
      for (const cmd of commands) {
        const r = classifyBashCommand(cmd);
        expect(r.reason).toBeTruthy();
        expect(typeof r.reason).toBe('string');
      }
    });
  });

  // ── Phase 2 golden tests: every allowlisted command shape ──
  // Acceptance criteria #3: classifier has golden tests for every allowlisted
  // command shape and rejects ambiguous shell constructs by default.

  describe('golden tests: all Tier 1 command shapes', () => {
    // Each test verifies tier1=true, the correct module, and presence of a reason
    const goldenTier1: Array<[string, string, string]> = [
      // [command, expectedModule, description]
      ['pwd', 'coreutils', 'bare pwd'],
      ['ls', 'coreutils', 'bare ls'],
      ['ls -la', 'coreutils', 'ls long+all'],
      ['ls -R src/', 'coreutils', 'ls recursive'],
      ['ls -1', 'coreutils', 'ls one-per-line'],
      ['cat file.txt', 'coreutils', 'cat single file'],
      ['cat a.txt b.txt', 'coreutils', 'cat multiple files'],
      ['cat -n file.txt', 'coreutils', 'cat with line numbers'],
      ['head file.txt', 'coreutils', 'bare head'],
      ['head -n 20 file.txt', 'coreutils', 'head with line count'],
      ['head -5 file.txt', 'coreutils', 'head short flag'],
      ['tail file.txt', 'coreutils', 'bare tail'],
      ['tail -n 50 file.txt', 'coreutils', 'tail with line count'],
      ['wc file.txt', 'coreutils', 'bare wc'],
      ['wc -l file.txt', 'coreutils', 'wc lines only'],
      ['wc -w file.txt', 'coreutils', 'wc words only'],
      ['wc -c file.txt', 'coreutils', 'wc bytes only'],
      ['rg pattern', 'ripgrep', 'bare rg'],
      ['rg -i pattern src/', 'ripgrep', 'rg case-insensitive'],
      ['rg --type ts pattern', 'ripgrep', 'rg with type filter'],
      ['grep -r pattern .', 'coreutils', 'grep recursive'],
      ['grep -rn pattern src/', 'coreutils', 'grep with line numbers'],
      ['find . -name "*.ts"', 'coreutils', 'find by name'],
      ['find . -type f', 'coreutils', 'find files only'],
      ['echo hello', 'coreutils', 'echo simple'],
      ['echo hello world', 'coreutils', 'echo multiple words'],
      ['basename /foo/bar.txt', 'coreutils', 'basename'],
      ['basename /foo/bar.txt .txt', 'coreutils', 'basename with suffix'],
      ['dirname /foo/bar.txt', 'coreutils', 'dirname'],
      ['realpath file.txt', 'coreutils', 'realpath'],
      ['stat file.txt', 'coreutils', 'stat'],
      ['file script.sh', 'coreutils', 'file'],
      ['tree', 'coreutils', 'bare tree'],
      ['tree src/', 'coreutils', 'tree with dir'],
      ['tree -L 2', 'coreutils', 'tree with depth'],
      ['du -sh .', 'coreutils', 'du summary'],
      ['du -h src/', 'coreutils', 'du human-readable'],
      ['df -h', 'coreutils', 'df human-readable'],
      ['git status', 'git-readonly', 'git status'],
      ['git log --oneline', 'git-readonly', 'git log oneline'],
      ['git log -10', 'git-readonly', 'git log with count'],
      ['git diff', 'git-readonly', 'git diff'],
      ['git diff --cached', 'git-readonly', 'git diff cached'],
      ['git show HEAD', 'git-readonly', 'git show'],
      ['git branch', 'git-readonly', 'git branch'],
      ['git branch -a', 'git-readonly', 'git branch all'],
      ['git tag', 'git-readonly', 'git tag'],
      ['git ls-files', 'git-readonly', 'git ls-files'],
      ['git ls-tree HEAD', 'git-readonly', 'git ls-tree'],
      ['git rev-parse HEAD', 'git-readonly', 'git rev-parse'],
      ['git describe', 'git-readonly', 'git describe'],
      ['git shortlog', 'git-readonly', 'git shortlog'],
      ['git blame file.ts', 'git-readonly', 'git blame'],
      ['git cat-file -p HEAD', 'git-readonly', 'git cat-file'],
      ['git --no-pager log', 'git-readonly', 'git with --no-pager'],
    ];

    for (const [command, expectedModule, description] of goldenTier1) {
      test(`Tier 1: ${description} (${command})`, () => {
        const r = classifyBashCommand(command);
        expect(r.tier1).toBe(true);
        expect(r.module).toBe(expectedModule);
        expect(r.reason).toBeTruthy();
      });
    }
  });

  describe('golden tests: all Tier 2 rejection patterns', () => {
    const goldenTier2: Array<[string, string]> = [
      // [command, reason-must-contain]
      ['', 'empty'],
      ['   ', 'empty'],
      ['cat file | head', 'pipe'],
      ['cat file | grep pattern | wc -l', 'pipe'],
      ['echo hello > out.txt', 'redirection'],
      ['echo hello >> out.txt', 'redirection'],
      ['cat < input.txt', 'redirection'],
      ['ls && echo done', 'chaining'],
      ['ls || echo failed', 'pipe'],
      ['ls; echo done', 'chaining'],
      ['echo $HOME', 'variable'],
      ['echo ${USER}', 'variable'],
      ['echo $(date)', 'variable'],
      ['echo `date`', 'subshell'],
      ['sleep 10 &', 'not in Tier 1 allowlist'],
      ['(cd src && ls)', 'chaining'],
      ['echo hello\necho world', 'multi-line'],
      ['rm file.txt', 'not in Tier 1 allowlist'],
      ['mv old new', 'not in Tier 1 allowlist'],
      ['cp src dst', 'not in Tier 1 allowlist'],
      ['npm test', 'not in Tier 1 allowlist'],
      ['npm install', 'not in Tier 1 allowlist'],
      ['python script.py', 'not in Tier 1 allowlist'],
      ['node index.js', 'not in Tier 1 allowlist'],
      ['curl https://example.com', 'not in Tier 1 allowlist'],
      ['wget https://example.com', 'not in Tier 1 allowlist'],
      ['chmod 755 file', 'not in Tier 1 allowlist'],
      ['chown user file', 'not in Tier 1 allowlist'],
      ['mkdir -p dir', 'not in Tier 1 allowlist'],
      ['git commit -m "fix"', 'not in read-only allowlist'],
      ['git push origin main', 'not in read-only allowlist'],
      ['git checkout -b branch', 'not in read-only allowlist'],
      ['git merge main', 'not in read-only allowlist'],
      ['git rebase main', 'not in read-only allowlist'],
      ['git reset --hard', 'not in read-only allowlist'],
      ['git add .', 'not in read-only allowlist'],
      ['git stash', 'not in read-only allowlist'],
      ['git pull', 'not in read-only allowlist'],
      ['git', 'no subcommand'],
      ['cat', 'stdin'],
      ['tail -f log', 'follow'],
      ['tail --follow log', 'follow'],
      ['find . -exec rm {} +', 'exec'],
      ['find . -delete', 'mutating'],
      ['find . -execdir cmd', 'mutating'],
    ];

    for (const [command, mustContain] of goldenTier2) {
      test(`Tier 2: rejects "${command.slice(0, 40)}"`, () => {
        const r = classifyBashCommand(command);
        expect(r.tier1).toBe(false);
        expect(r.reason.toLowerCase()).toContain(mustContain.toLowerCase());
      });
    }
  });
});
