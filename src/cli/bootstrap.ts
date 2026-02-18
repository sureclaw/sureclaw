import { existsSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentStateDir } from '../paths.js';

const SHARED_STATE_FILES = ['SOUL.md', 'IDENTITY.md'];

/** Reset an agent's identity by deleting evolvable files and copying a fresh BOOTSTRAP.md. */
export async function resetAgent(defDir: string, stateDir: string): Promise<void> {
  // Delete shared mutable state from stateDir
  for (const file of SHARED_STATE_FILES) {
    try { unlinkSync(join(stateDir, file)); } catch { /* may not exist */ }
  }

  // Delete BOOTSTRAP.md from stateDir (may exist from previous incomplete bootstrap)
  try { unlinkSync(join(stateDir, 'BOOTSTRAP.md')); } catch { /* may not exist */ }

  mkdirSync(stateDir, { recursive: true });

  // Copy BOOTSTRAP.md template from repo dir
  const bootstrapSrc = join(defDir, 'BOOTSTRAP.md');
  if (existsSync(bootstrapSrc)) {
    copyFileSync(bootstrapSrc, join(stateDir, 'BOOTSTRAP.md'));
  }

  // Note: per-user USER.md files are NOT deleted during bootstrap.
  // They represent learned user preferences that persist across agent resets.
}

export async function runBootstrap(args: string[]): Promise<void> {
  const agentName = args[0] || 'assistant';
  const defDir = resolve('agents', agentName);
  const stateDir = agentStateDir(agentName);

  if (!existsSync(defDir)) {
    console.error(`Agent definition directory not found: ${defDir}`);
    process.exit(1);
  }

  const hasSoul = existsSync(join(stateDir, 'SOUL.md'));
  if (hasSoul) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question(
        `This will erase ${agentName}'s personality and start fresh. Continue? (y/N) `,
        resolve,
      );
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  await resetAgent(defDir, stateDir);
  console.log(`[bootstrap] Reset complete. Run 'ax chat' to begin the bootstrap ritual.`);
}
