# Security Policy

We take security seriously. That's literally the whole point of this project.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

Found something? First of all: thank you. Seriously. We built Sureclaw because we believe security matters, and responsible disclosure is a big part of that.

Please report vulnerabilities via [GitHub Private Vulnerability Reporting](https://github.com/sureclaw/sureclaw/security/advisories/new).

**Do not open a public issue for security vulnerabilities.** We know it's tempting. Please don't. We need time to fix things before they're broadcast to the world.

### What to include

- A description of the vulnerability and what could go wrong
- Steps to reproduce (a proof-of-concept is chef's kiss)
- The affected component (e.g., IPC proxy, sandbox provider, credential handling)
- Your suggested severity (CRITICAL / HIGH / MEDIUM / LOW)

Don't worry if you're not sure about severity. We'd rather get a "this seems bad?" report than no report at all.

### What to expect

- **Acknowledgement** within 48 hours. We'll let you know we received it and that a human is looking at it.
- **Status update** within 7 days with our initial assessment.
- **Fix timeline** communicated once we've confirmed the issue. We aim to patch CRITICAL and HIGH issues within 14 days.

If the vulnerability is accepted, we'll coordinate disclosure with you and credit you in the release notes (unless you'd prefer to stay anonymous — we respect that). If we decline the report, we'll explain why. No ghosting.

## Security Architecture

Sureclaw was designed with the assumption that the AI agent is compromised. That's not pessimism — it's threat modeling. Here's how we keep things locked down:

- Agent containers have **no network access**. Not "restricted" access. No access.
- Credentials **never enter containers**. API keys are injected server-side via the IPC proxy. The agent can use them, but it can never see them.
- All external content is **taint-tagged**. Emails, web pages, anything from outside — we label it and track how much of it is in the conversation.
- Every action is **audited**. We log everything. The container can't modify the log.
- Provider loading uses a **static allowlist** (SC-SEC-002). No dynamic imports from config values. We don't trust config files that much.
- All file paths from untrusted input go through **safePath** (SC-SEC-004). Path traversal attacks are a classic, and we've seen too many of them to leave this to chance.
- IPC messages are validated with **strict Zod schemas** (SC-SEC-001). Unknown fields get rejected. Prototype pollution payloads get rejected. We validate everything before it touches a handler.

For the full deep-dive, see `docs/plans/sureclaw-security-hardening-spec.md`.
