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
});
