# Filesystem

### existsSync follows symlinks — use lstatSync for symlink existence checks
**Date:** 2026-03-01
**Context:** Writing tests for createCanonicalSymlinks that creates symlinks pointing to non-existent targets in test environment
**Lesson:** `existsSync()` follows symlinks and checks if the *target* exists. To check if a symlink *itself* exists (regardless of target), use `lstatSync()` wrapped in try-catch. This matters whenever symlinks point to paths that don't exist in the test environment.
**Tags:** testing, filesystem, symlinks, existsSync, lstatSync

### Declare variables before try blocks if they're needed in finally
**Date:** 2026-02-22
**Context:** `enterpriseScratch` was declared as `const` inside a try block but referenced in the finally block for cleanup
**Lesson:** If a variable is used in both try and finally, declare it with `let` before the try block. `const` inside try is scoped to the try block and invisible to finally/catch.
**Tags:** typescript, scoping, try-finally, server-completions
