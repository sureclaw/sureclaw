/**
 * Skill dependency installer.
 *
 * Reads SKILL.md files from workspace skill directories, parses install
 * specs, and runs missing installs with package-manager prefix env vars
 * redirecting binaries into the workspace prefix.
 *
 * Called by runners after the web proxy bridge is up (so HTTP_PROXY is set)
 * and before the agent loop starts.
 *
 * Uses execFileSync(shell, [flag, cmd]) rather than execSync(cmd)
 * because the `run` field is intentionally a shell command from a screened
 * SKILL.md — execFileSync makes the shell invocation explicit. Shell and
 * flag are platform-aware: /bin/sh -c on POSIX, cmd.exe /c on Windows.
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
function currentOS(): 'macos' | 'windows' | 'linux' | undefined {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'sunos':
    case 'aix':
      return 'linux';
    default: return undefined;
  }
}

/** Return shell executable and arg prefix for the current platform. */
function shellCommand(): { shell: string; flag: string } {
  if (process.platform === 'win32') return { shell: 'cmd.exe', flag: '/c' };
  return { shell: '/bin/sh', flag: '-c' };
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

export interface SkillSource {
  /** Directory containing SKILL.md files (e.g. /workspace/skills) */
  skillDir: string;
  /** Install prefix — binaries land under prefix/bin/ */
  prefix: string;
}

/**
 * Install missing skill dependencies.
 *
 * Each source maps a skill directory to its install prefix for binary installation.
 */
export async function installSkillDeps(sources: SkillSource[]): Promise<void> {
  const os = currentOS();
  if (!os) {
    logger.warn('unsupported_platform', { platform: process.platform });
    return;
  }

  const { shell, flag } = shellCommand();
  let installed = 0;

  for (const { skillDir, prefix } of sources) {
    const skills = loadSkillSpecs(skillDir);
    const steps = skills.flatMap(s => s.install);
    if (steps.length === 0) continue;

    const env = buildInstallEnv(prefix);

    for (const step of steps) {
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

      // Run install — shell command from screened SKILL.md, explicit shell invocation
      try {
        logger.info('installing', { run: step.run, bin: step.bin, prefix });
        execFileSync(shell, [flag, step.run], { env, timeout: INSTALL_TIMEOUT_MS, stdio: 'pipe' });
        installed++;
        logger.info('installed', { bin: step.bin });
      } catch (err) {
        logger.warn('install_failed', { run: step.run, error: (err as Error).message });
      }
    }
  }

  if (installed > 0) {
    logger.info('install_complete', { count: installed });
  }
}
