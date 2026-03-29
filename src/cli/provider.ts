/**
 * CLI commands for provider plugin management: ax provider add/remove/list/verify
 *
 * Workflow:
 *   ax provider add @community/provider-memory-postgres
 *     1. Installs the npm package to ~/.ax/plugins/
 *     2. Reads and validates the MANIFEST.json
 *     3. Prints the manifest for human review
 *     4. Prompts for confirmation
 *     5. Computes integrity hash and adds to plugins.lock
 *
 *   ax provider remove @community/provider-memory-postgres
 *     1. Removes from plugins.lock
 *     2. Removes installed files
 *
 *   ax provider list
 *     Lists all installed plugins from plugins.lock
 *
 *   ax provider verify
 *     Checks integrity of all installed plugins
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  readPluginLock,
  addPluginToLock,
  removePluginFromLock,
  computeIntegrity,
  pluginDir,
  verifyPluginIntegrity,
} from '../host/plugin-lock.js';
import {
  validateManifest,
  formatManifestForReview,
  type PluginManifest,
} from '../host/plugin-manifest.js';
import { safePath } from '../utils/safe-path.js';

// ═══════════════════════════════════════════════════════
// Provider CLI Router
// ═══════════════════════════════════════════════════════

export async function runProvider(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'add':
      await providerAdd(args.slice(1));
      break;
    case 'remove':
      await providerRemove(args.slice(1));
      break;
    case 'list':
      providerList();
      break;
    case 'verify':
      providerVerify();
      break;
    default:
      showProviderHelp();
      break;
  }
}

function showProviderHelp(): void {
  console.log(`
AX Provider Plugin Manager

Usage:
  ax provider add <package>      Install a third-party provider plugin
  ax provider remove <package>   Remove an installed provider plugin
  ax provider list               List installed provider plugins
  ax provider verify             Verify integrity of installed provider plugins

Examples:
  ax provider add @community/provider-memory-postgres
  ax provider remove @community/provider-memory-postgres
  ax provider list
  ax provider verify
`);
}

// ═══════════════════════════════════════════════════════
// Subcommands
// ═══════════════════════════════════════════════════════

async function providerAdd(args: string[]): Promise<void> {
  const packageName = args[0];
  if (!packageName) {
    console.error('Error: Package name required. Usage: ax provider add <package>');
    process.exit(1);
  }

  // Validate package name format
  if (!isValidPackageName(packageName)) {
    console.error(`Error: Invalid package name: "${packageName}"`);
    console.error('Package names must be valid npm package names (e.g., @community/provider-memory-postgres)');
    process.exit(1);
  }

  const installBase = pluginDir();
  mkdirSync(installBase, { recursive: true });

  // Install to a subdirectory named after the package (slashes replaced)
  const installDir = safePath(installBase, packageName.replace(/\//g, '__'));

  console.log(`Installing ${packageName}...`);

  try {
    // Install the package using npm
    mkdirSync(installDir, { recursive: true });
    execSync(
      `npm install --prefix "${installDir}" "${packageName}" --production --no-save`,
      { stdio: 'pipe' },
    );
  } catch (err) {
    console.error(`Failed to install ${packageName}: ${(err as Error).message}`);
    process.exit(1);
  }

  // Find and read MANIFEST.json
  const manifestPath = findManifest(installDir, packageName);
  if (!manifestPath) {
    console.error(`Error: ${packageName} does not contain a MANIFEST.json`);
    console.error('This package is not an AX provider plugin. Cleaning up...');
    rmSync(installDir, { recursive: true, force: true });
    process.exit(1);
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    console.error(`Error: Failed to parse MANIFEST.json in ${packageName}`);
    rmSync(installDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Validate manifest
  const validation = validateManifest(manifestRaw);
  if (!validation.valid) {
    console.error(`Error: Invalid MANIFEST.json in ${packageName}:`);
    for (const err of validation.errors!) {
      console.error(`  - ${err}`);
    }
    rmSync(installDir, { recursive: true, force: true });
    process.exit(1);
  }

  const manifest = validation.manifest!;

  // Print manifest for human review
  console.log('');
  console.log('=== Provider Plugin Manifest ===');
  console.log(formatManifestForReview(manifest));
  console.log('================================');
  console.log('');

  // Prompt for confirmation
  const confirmed = await promptConfirmation(
    'Do you want to install this provider plugin? Review the capabilities above carefully.'
  );
  if (!confirmed) {
    console.log('Installation cancelled. Cleaning up...');
    rmSync(installDir, { recursive: true, force: true });
    return;
  }

  // Compute integrity hash of the entry point
  const entryPath = safePath(installDir, manifest.main);
  if (!existsSync(entryPath)) {
    console.error(`Error: Provider plugin entry point not found: ${manifest.main}`);
    rmSync(installDir, { recursive: true, force: true });
    process.exit(1);
  }

  const content = readFileSync(entryPath);
  const integrity = computeIntegrity(content);

  // Add to plugins.lock
  addPluginToLock(manifest, integrity);

  console.log(`Provider plugin ${packageName} installed successfully.`);
  console.log(`  Provider: ${manifest.ax_provider.kind}/${manifest.ax_provider.name}`);
  console.log(`  Integrity: ${integrity.slice(0, 20)}...`);
  console.log('');
  console.log('Restart AX to load the new provider plugin.');
  console.log(`Use it in ax.yaml: providers.${manifest.ax_provider.kind}: ${manifest.ax_provider.name}`);
}

async function providerRemove(args: string[]): Promise<void> {
  const packageName = args[0];
  if (!packageName) {
    console.error('Error: Package name required. Usage: ax provider remove <package>');
    process.exit(1);
  }

  // Remove from lock file
  const removed = removePluginFromLock(packageName);
  if (!removed) {
    console.error(`Error: Provider plugin "${packageName}" is not installed.`);
    process.exit(1);
  }

  // Remove installed files
  const installBase = pluginDir();
  const installDir = safePath(installBase, packageName.replace(/\//g, '__'));

  if (existsSync(installDir)) {
    rmSync(installDir, { recursive: true, force: true });
  }

  console.log(`Provider plugin ${packageName} removed.`);
  console.log('Restart AX for the change to take effect.');
}

function providerList(): void {
  const lock = readPluginLock();

  if (Object.keys(lock.plugins).length === 0) {
    console.log('No provider plugins installed.');
    return;
  }

  console.log('Installed provider plugins:\n');

  for (const [name, entry] of Object.entries(lock.plugins)) {
    console.log(`  ${name}`);
    console.log(`    Provider: ${entry.kind}/${entry.name}`);
    console.log(`    Version:  ${entry.version}`);
    console.log(`    Network:  ${entry.capabilities.network.length > 0 ? entry.capabilities.network.join(', ') : 'none'}`);
    console.log(`    FS:       ${entry.capabilities.filesystem}`);
    console.log(`    Creds:    ${entry.capabilities.credentials.length > 0 ? entry.capabilities.credentials.join(', ') : 'none'}`);
    console.log(`    Installed: ${entry.installedAt}`);
    console.log('');
  }
}

function providerVerify(): void {
  const lock = readPluginLock();
  const installBase = pluginDir();

  if (Object.keys(lock.plugins).length === 0) {
    console.log('No provider plugins installed.');
    return;
  }

  let allGood = true;

  for (const [name] of Object.entries(lock.plugins)) {
    const installDir = safePath(installBase, name.replace(/\//g, '__'));

    if (!existsSync(installDir)) {
      console.log(`  MISSING  ${name} — not installed at ${installDir}`);
      allGood = false;
      continue;
    }

    const ok = verifyPluginIntegrity(name, installDir);
    if (ok) {
      console.log(`  OK       ${name}`);
    } else {
      console.log(`  FAILED   ${name} — integrity hash mismatch`);
      allGood = false;
    }
  }

  console.log('');
  if (allGood) {
    console.log('All provider plugins verified successfully.');
  } else {
    console.log('Some provider plugins failed verification. Run "ax provider remove" and re-install.');
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function isValidPackageName(name: string): boolean {
  // Allow scoped (@org/name) and unscoped (name) packages
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);
}

function findManifest(installDir: string, packageName: string): string | null {
  // Check common locations
  const candidates = [
    join(installDir, 'node_modules', packageName, 'MANIFEST.json'),
    join(installDir, 'MANIFEST.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

async function promptConfirmation(message: string): Promise<boolean> {
  // Non-interactive check (CI, piped stdin, --yes flag)
  if (!process.stdin.isTTY) {
    console.log('Non-interactive mode detected. Use --yes to auto-confirm.');
    return false;
  }

  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message });
}
