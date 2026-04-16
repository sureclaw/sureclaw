/**
 * WorkspaceProvider — git repository hosting for agent workspaces.
 *
 * Abstracts the git service that backs agent workspace repos.
 */
export interface WorkspaceProvider {
  /**
   * Get the clone URL for an agent's workspace repository.
   * Creates the repo if it doesn't exist.
   * @param agentId — Agent identifier (e.g., "agent-123", "user:alice")
   * @returns Clone URL and whether the repo was just created
   */
  getRepoUrl(agentId: string): Promise<{ url: string; created: boolean }>;

  /**
   * Close the provider (cleanup resources if needed).
   */
  close(): Promise<void>;
}

export type WorkspaceProviderName = 'git-http' | 'git-local';
