import { existsSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir as agentDirPath } from '../paths.js';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';

const EVOLVABLE_FILES = ['SOUL.md', 'IDENTITY.md'];

/** Reset an agent's identity by deleting evolvable files and copying a fresh BOOTSTRAP.md. */
export async function resetAgent(agentDir: string, templatesDir: string): Promise<void> {
  // Delete evolvable identity files
  for (const file of EVOLVABLE_FILES) {
    try { unlinkSync(join(agentDir, file)); } catch { /* may not exist */ }
  }

  // Delete BOOTSTRAP.md (may exist from previous incomplete bootstrap)
  try { unlinkSync(join(agentDir, 'BOOTSTRAP.md')); } catch { /* may not exist */ }

  mkdirSync(agentDir, { recursive: true });

  // Copy template files
  for (const file of ['BOOTSTRAP.md', 'USER_BOOTSTRAP.md']) {
    const src = join(templatesDir, file);
    if (existsSync(src)) {
      copyFileSync(src, join(agentDir, file));
    }
  }

  // Note: per-user USER.md files and the admins file are NOT deleted during bootstrap.
  // They represent learned user preferences and access control that persist across agent resets.
}

export async function runBootstrap(args: string[]): Promise<void> {
  const agentName = args[0] || 'main';
  const agentDir = agentDirPath(agentName);
  const templatesDir = resolveTemplatesDir();

  if (!existsSync(templatesDir)) {
    console.error(`Templates directory not found: ${templatesDir}`);
    process.exit(1);
  }

  const hasSoul = existsSync(join(agentDir, 'SOUL.md'));
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

  await resetAgent(agentDir, templatesDir);
  console.log(`[bootstrap] Reset complete. Run 'ax chat' to begin the bootstrap ritual.`);
}
