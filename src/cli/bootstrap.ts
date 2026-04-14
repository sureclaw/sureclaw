import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';
import type { DocumentStore } from '../providers/storage/types.js';

const EVOLVABLE_FILES = ['SOUL.md', 'IDENTITY.md'];

/** Reset an agent's identity by deleting evolvable files and seeding BOOTSTRAP.md in DocumentStore. */
export async function resetAgent(agentName: string, templatesDir: string, documents: DocumentStore): Promise<void> {
  // Delete evolvable identity files from DocumentStore
  for (const file of EVOLVABLE_FILES) {
    await documents.delete('identity', `${agentName}/${file}`);
  }

  // Delete BOOTSTRAP.md (will be re-seeded below)
  await documents.delete('identity', `${agentName}/BOOTSTRAP.md`);

  // Seed BOOTSTRAP.md from templates
  const src = join(templatesDir, 'BOOTSTRAP.md');
  if (existsSync(src)) {
    await documents.put('identity', `${agentName}/BOOTSTRAP.md`, readFileSync(src, 'utf-8'));
  }

  // Seed USER_BOOTSTRAP.md from templates
  const ubSrc = join(templatesDir, 'USER_BOOTSTRAP.md');
  if (existsSync(ubSrc)) {
    await documents.put('identity', `${agentName}/USER_BOOTSTRAP.md`, readFileSync(ubSrc, 'utf-8'));
  }
}

export async function runBootstrap(args: string[]): Promise<void> {
  const agentName = args[0];
  if (!agentName) {
    console.error('Error: agent name required. Usage: ax bootstrap <agent-name>');
    process.exit(1);
  }
  const templatesDir = resolveTemplatesDir();

  if (!existsSync(templatesDir)) {
    console.error(`Templates directory not found: ${templatesDir}`);
    process.exit(1);
  }

  // Open a lightweight DocumentStore to check/modify identity
  const { loadConfig } = await import('../config.js');
  const { loadProviders } = await import('../host/registry.js');
  const config = loadConfig();
  const providers = await loadProviders(config);
  const documents = providers.storage.documents;

  try {
    const hasSoul = await documents.get('identity', `${agentName}/SOUL.md`);
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

    await resetAgent(agentName, templatesDir, documents);
    console.log(`[bootstrap] Reset complete. Run 'ax serve' and open the admin dashboard to begin the bootstrap ritual.`);
  } finally {
    try { providers.storage.close(); } catch { /* ignore */ }
  }
}
