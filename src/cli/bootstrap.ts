import { existsSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir as agentDirPath, agentIdentityDir, agentIdentityFilesDir } from '../paths.js';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';

const EVOLVABLE_FILES = ['SOUL.md', 'IDENTITY.md'];

/** Reset an agent's identity by deleting evolvable files and copying a fresh BOOTSTRAP.md. */
export async function resetAgent(agentName: string, templatesDir: string): Promise<void> {
  const topDir = agentDirPath(agentName);
  const configDir = agentIdentityDir(agentName);
  const identityFilesDir = agentIdentityFilesDir(agentName);

  // Delete evolvable identity files from identityFilesDir
  for (const file of EVOLVABLE_FILES) {
    try { unlinkSync(join(identityFilesDir, file)); } catch { /* may not exist */ }
  }

  // Delete BOOTSTRAP.md from both configDir (authoritative) and identityFilesDir (agent-readable copy)
  try { unlinkSync(join(configDir, 'BOOTSTRAP.md')); } catch { /* may not exist */ }
  try { unlinkSync(join(identityFilesDir, 'BOOTSTRAP.md')); } catch { /* may not exist */ }

  // Delete bootstrap admin claim so a new first-user can claim during re-bootstrap
  try { unlinkSync(join(topDir, '.bootstrap-admin-claimed')); } catch { /* may not exist */ }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(identityFilesDir, { recursive: true });

  // BOOTSTRAP.md → both configDir (authoritative) and identityFilesDir (agent-readable copy)
  {
    const src = join(templatesDir, 'BOOTSTRAP.md');
    if (existsSync(src)) {
      copyFileSync(src, join(configDir, 'BOOTSTRAP.md'));
      copyFileSync(src, join(identityFilesDir, 'BOOTSTRAP.md'));
    }
  }

  // USER_BOOTSTRAP.md → configDir only (passed to agent via stdin payload, not mounted)
  {
    const src = join(templatesDir, 'USER_BOOTSTRAP.md');
    if (existsSync(src)) {
      copyFileSync(src, join(configDir, 'USER_BOOTSTRAP.md'));
    }
  }

  // Note: per-user USER.md files and the admins file are NOT deleted during bootstrap.
  // They represent learned user preferences and access control that persist across agent resets.
}

export async function runBootstrap(args: string[]): Promise<void> {
  const agentName = args[0] || 'main';
  const identityDir = agentIdentityFilesDir(agentName);
  const templatesDir = resolveTemplatesDir();

  if (!existsSync(templatesDir)) {
    console.error(`Templates directory not found: ${templatesDir}`);
    process.exit(1);
  }

  const hasSoul = existsSync(join(identityDir, 'SOUL.md'));
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

  await resetAgent(agentName, templatesDir);
  console.log(`[bootstrap] Reset complete. Run 'ax serve' and open the admin dashboard to begin the bootstrap ritual.`);
}
