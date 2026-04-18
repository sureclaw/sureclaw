# Storage Provider Lessons

### The `documents` table uses `collection`, not `kind`
**Date:** 2026-04-17
**Context:** Phase 7 Task 6 plan said "delete rows with `kind IN ('plugins', 'skills')`" but Kysely-generated SQL against that column errored. The actual schema (`storage_004_documents` in `src/providers/storage/migrations.ts` and the CRUD in `src/providers/storage/database.ts`) uses `collection` as the discriminator column. No `kind` column ever existed on `documents`.
**Lesson:** When a plan or doc references a column name, verify it against `src/providers/storage/migrations.ts` before writing the migration. For the `documents` table specifically: primary key is `(collection, key)`, content in `content`, blob payload in `data`. Use `collection` for any WHERE/GROUP BY by type.
**Tags:** documents, schema, migrations, collection, kind, DocumentStore

### Git repo is authoritative for identity; DocumentStore must be synced
**Date:** 2026-04-15
**Context:** After the git-native identity refactor, `loadIdentityFromGit()` reads from `git show HEAD:<path>`, but admin helpers (`isAgentBootstrapMode()`) still check DocumentStore. If DocumentStore isn't synced after git commits, admin state gets stuck.
**Lesson:** The git workspace repo is now the authoritative source for agent identity files. `seedAxDirectory()` must copy template files (BOOTSTRAP.md, USER_BOOTSTRAP.md, AGENTS.md, HEARTBEAT.md) into the `.ax/` directory and commit them. After `hostGitCommit()`, sync identity files from git back to DocumentStore so admin helpers reflect actual state. Both storage layers must stay in sync.
**Tags:** bootstrap, identity, DocumentStore, git, first-run, dual-storage

### Agent prompts must reference actual tool names, not stale ones
**Date:** 2026-04-15
**Context:** BOOTSTRAP.md referenced `identity()` tool and USER_BOOTSTRAP.md referenced `user_write` — neither exists in the tool catalog. Agent was told to use tools it couldn't find.
**Lesson:** When updating the tool catalog (adding/removing tools), grep templates/ and prompt modules for references to the old tool names. The agent only has access to tools in `TOOL_CATALOG` — prompts that reference anything else will confuse the LLM.
**Tags:** bootstrap, tools, templates, prompt, identity

### Agent must NOT run git commands — host handles git
**Date:** 2026-04-15
**Context:** Identity evolution guidance told agents to run `git add .ax/identity/ && git commit` after writing files. But `hostGitCommit()` already commits all workspace changes after each turn. Agents running git commands caused duplicate commits and confused state.
**Lesson:** Never instruct agents to run git commands in prompt modules or templates. The host manages all git operations (commit, push, reset) via `hostGitCommit()` after each agent turn. Agent writes files via `write_file`; host commits them. If you see `git add`, `git commit`, or `git push` in prompt text, it's a bug.
**Tags:** git, identity, prompt, agent, host
