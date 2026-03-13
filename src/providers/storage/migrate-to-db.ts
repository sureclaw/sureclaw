// src/providers/storage/migrate-to-db.ts — One-time migration of filesystem
// identity/skills files into the DocumentStore (SQLite documents table).
//
// Runs on first boot after upgrade. Checks for a _meta/migrated_storage_v1
// flag to ensure idempotency — if the flag exists, migration is skipped.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import type { DocumentStore } from './types.js';

const META_COLLECTION = '_meta';
const META_KEY = 'migrated_storage_v1';

/**
 * Recursively collect all .md files under a directory.
 * Returns paths relative to `baseDir`.
 */
async function collectMdFiles(baseDir: string): Promise<string[]> {
  if (!existsSync(baseDir)) return [];

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(relative(baseDir, fullPath));
      }
    }
  }

  await walk(baseDir);
  return results;
}

/**
 * Read a file and return its content, or null if unreadable.
 */
async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Migrate filesystem-based identity and skills files into DocumentStore.
 *
 * Scans ~/.ax/agents/ for:
 *   - Agent identity files (identity/*.md, BOOTSTRAP.md, USER_BOOTSTRAP.md)
 *   - Agent skills (skills/**\/*.md)
 *   - User identity (users/<userId>/USER.md)
 *   - User skills (users/<userId>/skills/**\/*.md)
 *
 * Each file is stored via documents.put() with appropriate collection and key.
 * A _meta/migrated_storage_v1 flag prevents re-running.
 */
export async function migrateFilesToDb(
  documents: DocumentStore,
  axHomePath: string,
  log?: (msg: string) => void,
): Promise<{ migrated: boolean; filesImported: number }> {
  const emit = log ?? (() => {});

  // Check idempotency flag
  const existing = await documents.get(META_COLLECTION, META_KEY);
  if (existing) {
    emit('Migration already completed, skipping');
    return { migrated: false, filesImported: 0 };
  }

  const agentsDir = join(axHomePath, 'agents');
  if (!existsSync(agentsDir)) {
    emit('No agents directory found, writing migration flag');
    await documents.put(META_COLLECTION, META_KEY, new Date().toISOString());
    return { migrated: true, filesImported: 0 };
  }

  let filesImported = 0;

  // List agent directories
  let agentEntries;
  try {
    agentEntries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    emit('Cannot read agents directory, writing migration flag');
    await documents.put(META_COLLECTION, META_KEY, new Date().toISOString());
    return { migrated: true, filesImported: 0 };
  }

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentId = agentEntry.name;
    const agentBaseDir = join(agentsDir, agentId, 'agent');

    // 1. Import identity files from agent/identity/*.md
    const identityDir = join(agentBaseDir, 'identity');
    const identityFiles = await collectMdFiles(identityDir);
    for (const relPath of identityFiles) {
      const content = await safeReadFile(join(identityDir, relPath));
      if (content === null) {
        emit(`Warning: cannot read ${join(identityDir, relPath)}, skipping`);
        continue;
      }
      const key = `${agentId}/${relPath}`;
      await documents.put('identity', key, content);
      filesImported++;
      emit(`Imported identity: ${key}`);
    }

    // 2. Import BOOTSTRAP.md and USER_BOOTSTRAP.md from agent/ dir
    for (const filename of ['BOOTSTRAP.md', 'USER_BOOTSTRAP.md']) {
      const filePath = join(agentBaseDir, filename);
      const content = await safeReadFile(filePath);
      if (content !== null) {
        const key = `${agentId}/${filename}`;
        await documents.put('identity', key, content);
        filesImported++;
        emit(`Imported identity: ${key}`);
      }
    }

    // 3. Import agent skills from agent/skills/**/*.md
    const skillsDir = join(agentBaseDir, 'skills');
    const skillFiles = await collectMdFiles(skillsDir);
    for (const relPath of skillFiles) {
      const content = await safeReadFile(join(skillsDir, relPath));
      if (content === null) {
        emit(`Warning: cannot read ${join(skillsDir, relPath)}, skipping`);
        continue;
      }
      // Strip .md extension from key
      const key = `${agentId}/${relPath.replace(/\.md$/, '')}`;
      await documents.put('skills', key, content);
      filesImported++;
      emit(`Imported skill: ${key}`);
    }

    // 4. Scan users directory
    const usersDir = join(agentsDir, agentId, 'users');
    if (!existsSync(usersDir)) continue;

    let userEntries;
    try {
      userEntries = await readdir(usersDir, { withFileTypes: true });
    } catch {
      emit(`Warning: cannot read users directory for agent ${agentId}, skipping`);
      continue;
    }

    for (const userEntry of userEntries) {
      if (!userEntry.isDirectory()) continue;
      const userId = userEntry.name;

      // 4a. Import USER.md
      const userMdPath = join(usersDir, userId, 'USER.md');
      const userMdContent = await safeReadFile(userMdPath);
      if (userMdContent !== null) {
        const key = `${agentId}/users/${userId}/USER.md`;
        await documents.put('identity', key, userMdContent);
        filesImported++;
        emit(`Imported user identity: ${key}`);
      }

      // 4b. Import user skills from users/<userId>/skills/**/*.md
      const userSkillsDir = join(usersDir, userId, 'skills');
      const userSkillFiles = await collectMdFiles(userSkillsDir);
      for (const relPath of userSkillFiles) {
        const content = await safeReadFile(join(userSkillsDir, relPath));
        if (content === null) {
          emit(`Warning: cannot read ${join(userSkillsDir, relPath)}, skipping`);
          continue;
        }
        const key = `${agentId}/users/${userId}/${relPath.replace(/\.md$/, '')}`;
        await documents.put('skills', key, content);
        filesImported++;
        emit(`Imported user skill: ${key}`);
      }
    }
  }

  // Write migration flag
  await documents.put(META_COLLECTION, META_KEY, new Date().toISOString());
  emit(`Migration complete: ${filesImported} files imported`);

  return { migrated: true, filesImported };
}
