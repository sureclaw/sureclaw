/**
 * Skill dependency installer.
 *
 * Reads SKILL.md files from workspace skill directories, parses install
 * specs, and runs missing installs with package-manager prefix env vars
 * redirecting binaries to the target workspace path.
 *
 * Called by runners after the web proxy bridge is up (so HTTP_PROXY is set)
 * and before the agent loop starts.
 *
 * Uses execFileSync('/bin/sh', ['-c', cmd]) rather than execSync(cmd)
 * because the `run` field is intentionally a shell command from a screened
 * SKILL.md — execFileSync makes the shell invocation explicit.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgentSkill } from '../utils/skill-format-parser.js';
import { binExists } from '../utils/bin-exists.js';
import { getLogger } from '../logger.js';
import type { ParsedAgentSkill } from '../providers/skills/types.js';

const logger = getLogger().child({ component: 'skill-installer' });

const INSTALL_TIMEOUT_MS = 120_000;

/** Map process.platform to the os values used in SKILL.md install specs. */
function currentOS(): string {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'linux';
  }
}

/** Build env vars that redirect all package managers to install under prefix. */
function buildInstallEnv(prefix: string): Record<string, string> {
  const binDir = join(prefix, 'bin');
  return {
    ...process.env as Record<string, string>,
    npm_config_prefix: prefix,
    PYTHONUSERBASE: prefix,
    CARGO_INSTALL_ROOT: prefix,
    GOBIN: binDir,
    UV_TOOL_BIN_DIR: binDir,
  };
}

/**
 * Read and parse all SKILL.md files from a directory.
 * Supports both file-based (foo.md) and directory-based (foo/SKILL.md) skills.
 */
function loadSkillSpecs(dir: string): ParsedAgentSkill[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const skills: ParsedAgentSkill[] = [];

    for (const entry of entries) {
      try {
        let raw: string | undefined;

        if (entry.isFile() && entry.name.endsWith('.md')) {
          raw = readFileSync(join(dir, entry.name), 'utf-8');
        } else if (entry.isDirectory()) {
          const skillMdPath = join(dir, entry.name, 'SKILL.md');
          if (existsSync(skillMdPath)) {
            raw = readFileSync(skillMdPath, 'utf-8');
          }
        }

        if (raw) {
          skills.push(parseAgentSkill(raw));
        }
      } catch (err) {
        logger.warn('skill_parse_failed', { entry: entry.name, error: (err as Error).message });
      }
    }

    return skills;
  } catch {
    return [];
  }
}

/**
 * Install missing skill dependencies.
 *
 * @param skillDirs - Directories containing SKILL.md files (agent/skills, user/skills)
 * @param prefix - Target install prefix (/workspace/user or /workspace/agent)
 */
export async function installSkillDeps(skillDirs: string[], prefix: string): Promise<void> {
  const skills = skillDirs.flatMap(dir => loadSkillSpecs(dir));
  const stepsToRun = skills.flatMap(s => s.install);

  if (stepsToRun.length === 0) return;

  const os = currentOS();
  const env = buildInstallEnv(prefix);
  let installed = 0;

  for (const step of stepsToRun) {
    // OS filter
    if (step.os?.length && !step.os.includes(os)) {
      logger.debug('skip_os', { run: step.run, os: step.os, current: os });
      continue;
    }

    // Already installed?
    if (step.bin && await binExists(step.bin)) {
      logger.debug('skip_exists', { bin: step.bin });
      continue;
    }

    // Run install — shell command from screened SKILL.md, explicit /bin/sh invocation
    try {
      logger.info('installing', { run: step.run, bin: step.bin, prefix });
      execFileSync('/bin/sh', ['-c', step.run], { env, timeout: INSTALL_TIMEOUT_MS, stdio: 'pipe' });
      installed++;
      logger.info('installed', { bin: step.bin });
    } catch (err) {
      logger.warn('install_failed', { run: step.run, error: (err as Error).message });
    }
  }

  if (installed > 0) {
    logger.info('install_complete', { count: installed, prefix });
  }
}
