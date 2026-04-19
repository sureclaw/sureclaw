/**
 * WorkspaceProvider — git repository hosting for agent workspaces.
 *
 * Abstracts the git service that backs agent workspace repos.
 */
export interface CommitFilesInput {
  /**
   * Files to write (`content` is a Buffer or string) or delete (`content` is null).
   * Paths are repo-relative, forward-slash-separated.
   */
  files: Array<{ path: string; content: Buffer | string | null }>;
  message: string;
  /** Author metadata for the commit. Defaults to a generic AX host identity. */
  author?: { name: string; email: string };
}

export interface CommitFilesResult {
  /**
   * SHA of `refs/heads/main` after the call (unchanged if `changed === false`).
   * `null` only in the degenerate case of a no-op against a repo with no
   * commits yet — e.g. deleting from an unborn HEAD. In every other case this
   * is a 40-char hex commit sha.
   */
  commit: string | null;
  /** True if a new commit was created; false if the tree was already up to date. */
  changed: boolean;
}

export interface WorkspaceProvider {
  /**
   * Get the clone URL for an agent's workspace repository.
   * Attempts to create the repo if it doesn't exist (best-effort; may
   * exhaust retries on HTTP failures). Callers should verify repo
   * content rather than relying solely on the `created` flag.
   * @param agentId — Agent identifier (e.g., "agent-123", "user:alice")
   * @returns Clone URL and whether the repo was freshly created in this call
   */
  getRepoUrl(agentId: string): Promise<{ url: string; created: boolean }>;

  /**
   * Return a local bare-repo path for this agent that callers can read
   * directly (`git ls-tree`, `git cat-file`, `git ls-remote`, etc.). For
   * `git-local`, this is the authoritative bare repo on disk. For
   * `git-http`, this is a fetch-on-demand mirror of the remote repo,
   * cached under `~/.ax/repos/<agentId>`.
   *
   * The returned path is suitable for both read ops and as the target of
   * `workspace.commitFiles` (which shares the same mirror for git-http so
   * a commit + push uses an up-to-date parent).
   *
   * Idempotent: safe to call per-request. First call does the initial
   * clone + config; subsequent calls refresh via `git fetch`.
   */
  ensureLocalMirror(agentId: string): Promise<string>;

  /**
   * Commit a set of files into the agent's repo on `refs/heads/main`.
   *
   * Idempotent: if the resulting tree is identical to the parent commit's
   * tree, no new commit is created and `{ changed: false, commit: <parent> }`
   * is returned. On an empty repo with only deletions (no actual content
   * change), also a no-op.
   *
   * Failure modes surface as thrown errors — the primitive is a building
   * block, retry/backoff policy lives with the caller.
   */
  commitFiles(agentId: string, input: CommitFilesInput): Promise<CommitFilesResult>;

  /**
   * Close the provider (cleanup resources if needed).
   */
  close(): Promise<void>;
}

export type WorkspaceProviderName = 'git-http' | 'git-local';
