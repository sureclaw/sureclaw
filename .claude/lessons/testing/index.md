# Testing

Lessons about test patterns, infrastructure, mocking strategies, and test environment setup.

## Entries

- Sandbox providers use source-level test assertions (read source, check patterns) [patterns.md](patterns.md)
- Regex tests on source code are fragile — prefer semantic assertions [patterns.md](patterns.md)
- Retry tests with real backoff delays need careful design [patterns.md](patterns.md)
- Mock LLM provider doesn't echo model names — use provider failures to verify routing [patterns.md](patterns.md)
- Smoke tests use stdout markers to detect server readiness [patterns.md](patterns.md)
- Changing prompt module output breaks tests in multiple locations [patterns.md](patterns.md)
- When adding new prompt modules, update integration test module count [patterns.md](patterns.md)
- Use createHttpServer for isolated SSE endpoint tests instead of full AxServer [patterns.md](patterns.md)
- Bare repo with no commits → `git ls-tree refs/heads/main` fails; always seed a file even for "empty" test cases [patterns.md](patterns.md)
- Playwright reuseExistingServer:true silently serves a stale bundle from another worktree [infrastructure.md](infrastructure.md)
- Tool count tests are scattered across many test files [infrastructure.md](infrastructure.md)
- Adding a new tool category requires updating ToolFilterContext in test filter objects [infrastructure.md](infrastructure.md)
- Tool count is hardcoded in multiple test files — update all of them [infrastructure.md](infrastructure.md)
- Set AX_HOME in tests that use workspace/identity/scratch paths [infrastructure.md](infrastructure.md)
- scratchDir requires valid session ID format [infrastructure.md](infrastructure.md)
- Multiple TestHarness instances need careful dispose ordering [infrastructure.md](infrastructure.md)
- Integration tests that spawn server processes need shared servers and long timeouts [infrastructure.md](infrastructure.md)
- Always run full test suite before committing — targeted runs miss sync tests [infrastructure.md](infrastructure.md)
- Always disable pino file transport in tests that set AX_HOME to a temp dir [infrastructure.md](infrastructure.md)
- Test concurrent async handlers using the handler factory directly, not the IPC wrapper [concurrency.md](concurrency.md)
- :memory: SQLite databases don't work with separate connections [sqlite.md](sqlite.md)
- Separate Kysely + openDatabase connections can't share :memory: databases [sqlite.md](sqlite.md)
- ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite [sqlite.md](sqlite.md)
- Always check runMigrations result.error in store factories [sqlite.md](sqlite.md)
- Structured content serialization — use JSON detection on load [sqlite.md](sqlite.md)
- Bootstrap lifecycle must be tested end-to-end including server restarts [bootstrap.md](bootstrap.md)
- isAgentBootstrapMode requires BOTH SOUL.md and IDENTITY.md to complete bootstrap [bootstrap.md](bootstrap.md)
