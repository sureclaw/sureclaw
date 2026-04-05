# Auth Provider Journal

## [2026-04-05 10:00] — Add AuthProvider contract types

**Task:** Create the AuthProvider contract types as the first step of the pluggable auth provider category
**What I did:** Created `src/providers/auth/types.ts` with AuthRole, AuthUser, AuthResult, and AuthProvider interface. Follows the co-located types pattern used by all other provider categories.
**Files touched:** `src/providers/auth/types.ts` (created)
**Outcome:** Success — compiles cleanly with `npx tsc --noEmit`
**Notes:** The three-way return from authenticate() (null / {authenticated:false} / {authenticated:true, user}) is the key design choice — null means "not my request, try next provider" which enables provider chaining.
