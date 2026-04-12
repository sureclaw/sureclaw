/**
 * WorkspaceProvider — git repository hosting for agent workspaces.
 *
 * Abstracts the git service that backs agent workspace repos.
 */
export interface WorkspaceProvider {
  /**
   * Get the clone URL for an agent's workspace repository.
   * @param agentId — Agent identifier (e.g., "agent-123", "user:alice")
   * @returns Full clone URL (e.g., "http://git-server:8000/agent-123.git")
   */
  getRepoUrl(agentId: string): Promise<string>;

  /**
   * Close the provider (cleanup resources if needed).
   */
  close(): Promise<void>;
}

export type WorkspaceProviderName = 'git-http';
