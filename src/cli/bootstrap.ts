import { existsSync, unlinkSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'];

/** Reset an agent's identity by deleting evolvable files and copying a fresh BOOTSTRAP.md. */
export async function resetAgent(agentDir: string): Promise<void> {
  for (const file of IDENTITY_FILES) {
    try { unlinkSync(join(agentDir, file)); } catch { /* may not exist */ }
  }

  mkdirSync(agentDir, { recursive: true });
  const bootstrapSrc = resolve('agents/assistant/BOOTSTRAP.md');
  if (existsSync(bootstrapSrc)) {
    copyFileSync(bootstrapSrc, join(agentDir, 'BOOTSTRAP.md'));
  }
}

export async function runBootstrap(args: string[]): Promise<void> {
  const agentName = args[0] || 'assistant';
  const agentDir = resolve('agents', agentName);

  if (!existsSync(agentDir)) {
    console.error(`Agent directory not found: ${agentDir}`);
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

  await resetAgent(agentDir);
  console.log(`[bootstrap] Reset complete. Run 'ax chat' to begin the bootstrap ritual.`);
}
