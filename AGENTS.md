# AGENTS.md

## Project

Nimbot is a self-hosted platform for running persistent AI agents through Telegram. Each agent runs in its own Docker container with a persistent workspace.

Phase 0 is in progress: the monorepo, the Agent Host image, and a minimal ACP client exist in `apps/agent-host/`.

- [MVP.md](MVP.md) is the source of truth for scope, architecture, and phases.
- [README.md](README.md) is the short public summary and must stay consistent with MVP.md.

## Scope rules

- Build only what MVP.md section 2.1 includes. Anything in section 2.2 or the post-MVP backlog (section 14) is out of scope unless the user asks for it.
- Work in phase order, starting with Phase 0 (validating OpenCode through ACP inside Docker).
- Prefer the simplest thing that satisfies the phase's acceptance criteria. Do not add services, packages, or abstractions the current phase does not need.
- No PostgreSQL, Redis, Kubernetes, or message brokers. Storage is SQLite and Docker volumes.

## Stack

TypeScript (strict mode) on Node.js LTS, pnpm workspaces, Hono, grammY, Drizzle with SQLite, Docker, Playwright, Vitest, ESLint, and Prettier.

Use pnpm, not npm or yarn.

## Layout

Planned monorepo layout, from MVP.md section 5:

- `apps/server/` — Nimbot Server: Telegram, agent registry, task routing, container management
- `apps/agent-host/` — runs inside each agent container: AI engine, tasks, workspace
- `packages/` — shared code
- `infrastructure/docker/` — Dockerfiles
- `tests/` — integration and end-to-end tests

## Commands

- `pnpm install` — install dependencies
- `pnpm build` — compile all workspaces
- `pnpm lint` — ESLint and Prettier check (`pnpm format` to fix formatting)
- `pnpm typecheck` — type-check all workspaces
- `pnpm test` — run Vitest
- `docker build -f infrastructure/docker/agent-host.Dockerfile -t nimbot-agent-host .` — build the Agent Host image

Run lint, type-check, and tests before finishing any change.

## Architecture constraints

- The Nimbot Server must never run agent-generated shell commands on the host OS; they run only inside the agent's container.
- Agent containers run as non-root, with resource limits, and must not get the Docker socket or server credentials.
- Keep Telegram-specific code out of the agent runtime.
- Keep OpenCode-specific code behind the engine interface.
- Persist messages and tasks before executing them.
- Deleting an agent must not silently delete its persistent volume.

## Conventions

- Do not create standalone manual validation guides or test run reports unless the user explicitly requests them. If the user needs to run commands to test something, provide the commands and instructions directly in chat.
- Never commit secrets. Configuration comes from environment variables; keep `.env.example` current once it exists.
- Add tests with new behaviour.
- When a change affects scope or architecture, update MVP.md and README.md in the same change.
- Commit or push only when the user asks.
- Match the existing commit message style: an English imperative subject without Conventional Commit prefixes, followed by a blank line and a short explanatory body.
- Include a `Co-Authored-By` trailer for the assisting AI, naming both the assistant and the model and using the provider's attribution email. Use the actual model identity available in the session; do not invent a model name or version.
