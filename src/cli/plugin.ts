/**
 * CLI commands for plugin management: ax plugin install/remove/list
 *
 * TODO(phase7-task4): this file is a temporary stub. Task 3 stripped the
 * legacy plugin manifest/install machinery (fetcher/install/parser/store/
 * types) but left this CLI in place for Task 4 to delete wholesale. Until
 * then, every subcommand errors out.
 */

export async function runPlugin(_args: string[]): Promise<void> {
  console.error(
    'The `ax plugin` CLI has been retired. Skills are now managed via git-native seeds; MCP servers via `ax mcp`.',
  );
  process.exit(1);
}
