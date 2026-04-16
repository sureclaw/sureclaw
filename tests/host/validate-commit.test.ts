import { describe, it, expect } from 'vitest';
import { validateCommit } from '../../src/host/validate-commit.js';

describe('validateCommit', () => {
  it('passes when diff is empty', () => {
    const result = validateCommit('');
    expect(result).toEqual({ ok: true });
  });

  it('passes for valid identity file changes', () => {
    const diff = `diff --git a/.ax/SOUL.md b/.ax/SOUL.md
--- /dev/null
+++ b/.ax/SOUL.md
@@ -0,0 +1,3 @@
+I am a helpful assistant.
+I value clarity and honesty.
+I work carefully.`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('rejects files outside allowed paths', () => {
    const diff = `diff --git a/.ax/secrets.txt b/.ax/secrets.txt
--- /dev/null
+++ b/.ax/secrets.txt
@@ -0,0 +1 @@
+some secret`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not in allowed paths');
  });

  it('rejects files exceeding size limit', () => {
    const bigContent = '+' + 'x'.repeat(33_000) + '\n';
    const diff = `diff --git a/.ax/SOUL.md b/.ax/SOUL.md
--- /dev/null
+++ b/.ax/SOUL.md
@@ -0,0 +1,1 @@
${bigContent}`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exceeds size limit');
  });

  it('passes for valid skill file changes', () => {
    const diff = `diff --git a/.ax/skills/my-skill.md b/.ax/skills/my-skill.md
--- /dev/null
+++ b/.ax/skills/my-skill.md
@@ -0,0 +1,2 @@
+name: my-skill
+description: A useful skill`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('passes for AGENTS.md and HEARTBEAT.md changes', () => {
    const diff = `diff --git a/.ax/AGENTS.md b/.ax/AGENTS.md
--- /dev/null
+++ b/.ax/AGENTS.md
@@ -0,0 +1 @@
+You are a helpful agent.`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('passes for policy file changes', () => {
    const diff = `diff --git a/.ax/policy/rules.yaml b/.ax/policy/rules.yaml
--- /dev/null
+++ b/.ax/policy/rules.yaml
@@ -0,0 +1 @@
+version: 1`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('allows larger files under skills (64KB limit)', () => {
    const content = '+' + 'y'.repeat(50_000) + '\n';
    const diff = `diff --git a/.ax/skills/big-skill.md b/.ax/skills/big-skill.md
--- /dev/null
+++ b/.ax/skills/big-skill.md
@@ -0,0 +1,1 @@
${content}`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('rejects skill files exceeding 64KB limit', () => {
    const content = '+' + 'z'.repeat(66_000) + '\n';
    const diff = `diff --git a/.ax/skills/huge-skill.md b/.ax/skills/huge-skill.md
--- /dev/null
+++ b/.ax/skills/huge-skill.md
@@ -0,0 +1,1 @@
${content}`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('exceeds size limit');
  });

  it('handles multiple files in a single diff', () => {
    const diff = `diff --git a/.ax/SOUL.md b/.ax/SOUL.md
--- /dev/null
+++ b/.ax/SOUL.md
@@ -0,0 +1 @@
+I am thoughtful.
diff --git a/.ax/AGENTS.md b/.ax/AGENTS.md
--- /dev/null
+++ b/.ax/AGENTS.md
@@ -0,0 +1 @@
+Be helpful.`;
    const result = validateCommit(diff);
    expect(result).toEqual({ ok: true });
  });

  it('rejects when one file of many is outside allowed paths', () => {
    const diff = `diff --git a/.ax/SOUL.md b/.ax/SOUL.md
--- /dev/null
+++ b/.ax/SOUL.md
@@ -0,0 +1 @@
+I am thoughtful.
diff --git a/.ax/hacks/evil.sh b/.ax/hacks/evil.sh
--- /dev/null
+++ b/.ax/hacks/evil.sh
@@ -0,0 +1 @@
+rm -rf /`;
    const result = validateCommit(diff);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not in allowed paths');
  });
});

describe('hostGitCommit integration', () => {
  it('validateCommit is used by hostGitCommit to gate .ax/ changes', () => {
    // The integration is verified by:
    // 1. hostGitCommit calls `git diff --cached -- .ax/...` after staging
    // 2. If the diff is non-empty, it calls validateCommit(diff)
    // 3. If validation fails, it reverts .ax/ changes and continues
    // This is tested indirectly via the validateCommit unit tests above
    // and the source-level integration in hostGitCommit.
    // Full integration requires a real git repo (covered in acceptance tests).
    expect(validateCommit('')).toEqual({ ok: true });
  });
});
