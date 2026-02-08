import { resolve, join, sep } from 'node:path';

/**
 * Safely construct a filesystem path from a base directory and untrusted segments.
 *
 * SECURITY (SC-SEC-004): This is the canonical defense against path traversal.
 * Every file-based provider MUST use this function when constructing paths from
 * any input that could be influenced by the agent, user messages, or external content.
 *
 * The function:
 * 1. Sanitizes each segment (removes dangerous characters)
 * 2. Joins segments to the base directory
 * 3. Resolves the result to an absolute path
 * 4. Verifies the resolved path is within the base directory
 * 5. Throws if containment check fails
 */
export function safePath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = resolve(baseDir);

  const sanitized = segments.map(seg => {
    let clean = seg
      .replace(/[/\\]/g, '_')          // path separators -> underscore
      .replace(/\0/g, '')              // null bytes -> remove
      .replace(/\.\./g, '_')           // .. sequences -> underscore
      .replace(/:/g, '_')              // colons -> underscore (Windows ADS)
      .replace(/^[\s.]+|[\s.]+$/g, '') // trim leading/trailing dots and spaces
      ;

    if (clean.length === 0) clean = '_empty_';
    if (clean.length > 255) clean = clean.slice(0, 255);

    return clean;
  });

  const constructed = join(resolvedBase, ...sanitized);
  const resolvedFull = resolve(constructed);

  // CRITICAL: Containment check
  if (resolvedFull !== resolvedBase && !resolvedFull.startsWith(resolvedBase + sep)) {
    throw new Error(
      `Path traversal blocked: segments ${JSON.stringify(segments)} ` +
      `resolved to "${resolvedFull}" which is outside base "${resolvedBase}"`
    );
  }

  return resolvedFull;
}

/**
 * Validates that an existing path is within a base directory.
 * Use this when you receive a path from storage rather than constructing one.
 */
export function assertWithinBase(baseDir: string, targetPath: string): string {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new Error(
      `Path "${resolvedTarget}" is outside base directory "${resolvedBase}"`
    );
  }

  return resolvedTarget;
}
