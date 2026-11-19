# AGENTS.md

## Project

Nimbot is a self-hosted platform for running persistent AI agents through Telegram. Each agent runs in its own Docker container with a persistent workspace.

The MVP is complete. The Agent Host lives in `apps/agent-host/`, the Nimbot Server in `apps/server/`, and the administration UI in `apps/panel/`.

- [README.md](README.md) is the source of truth for current scope, architecture, and future work.
- [docs/INSTALL.md](docs/INSTALL.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) cover installation and operations.

## Scope rules

- Keep work within the current features documented in README.md. Future work is out of scope unless the user asks for it.
- Prefer the simplest thing that satisfies the requested change. Do not add services, packages, or abstractions it does not need.
- No PostgreSQL, Redis, Kubernetes, or message brokers. Storage is SQLite and Docker volumes.
- Until a stable version is reached, every installation starts from scratch. Do not develop database or persisted-state migrations or backward compatibility for previous installations; update schema initialization directly.

## Stack

TypeScript (strict mode) on Node.js LTS, pnpm workspaces, Hono, Zod for input validation, grammY, Drizzle with SQLite, Docker, Playwright, Vitest, ESLint, and Prettier.

Use pnpm, not npm or yarn.

## Layout

Monorepo layout:

- `apps/server/` — Nimbot Server: authenticated administration panel, Telegram, agent registry, task routing, container management
- `apps/agent-host/` — runs inside each agent container: AI engine, tasks, workspace
- `apps/panel/` — administration UI
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
- Each agent must have its own distinct Telegram bot and owner-bound private chat; the authenticated web panel handles administration. Do not add a management bot. Do not introduce a shared selected-agent or `/use` workflow.
- Keep Telegram bot tokens and all polling connections on the Nimbot Server, outside agent containers.
- Keep Telegram-specific code out of the agent runtime.
- Keep OpenCode-specific code behind the engine interface.
- Persist messages and tasks before executing them.
- Deleting an agent must not silently delete its persistent volume.

## Conventions

- English is the primary language. Write all user-facing content (panel pages, Telegram bot replies, CLI prompts, API errors), code, comments, tests, and documentation in English. Multi-language content will be added later; until then, do not add text in other languages or introduce localization infrastructure.
- Do not create standalone manual validation guides or test run reports unless the user explicitly requests them. If the user needs to run commands to test something, provide the commands and instructions directly in chat.
- Never commit secrets. Configuration comes from environment variables; keep `.env.example` current once it exists.
- Add tests with new behaviour.
- When a change affects scope or architecture, update README.md in the same change.
- Commit or push only when the user asks.
- Match the existing commit message style: an English imperative subject without Conventional Commit prefixes, followed by a blank line and a short explanatory body.
- Include a `Co-Authored-By` trailer for the assisting AI, naming both the assistant and the model and using the provider's attribution email. Use the actual model identity available in the session; do not invent a model name or version.
