/**
 * Server lifecycle — startup orchestration and graceful shutdown.
 * Wires together channels, scheduler, HTTP server, IPC server,
 * and persistent stores.
 *
 * cleanStaleWorkspaces was removed — workspaces are now ephemeral
 * (cloned from git each turn, deleted after).
 */
