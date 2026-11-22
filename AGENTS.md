# AGENTS.md

## Project

Nimbot is a self-hosted platform for running persistent AI agents through Telegram. Each agent has a persistent workspace.

The Nimbot Server starts each agent as an Agent Host subprocess in both native development and Docker deployments. The recommended Docker deployment packages the entire application in one non-root container per installation, without a Docker socket. New work must follow the constraints below.

The MVP is complete. The Agent Host lives in `apps/agent-host/`, the Nimbot Server in `apps/server/`, and the administration UI in `apps/panel/`.

- [README.md](README.md) is the source of truth for current scope, architecture, and future work.
- [docs/INSTALL.md](docs/INSTALL.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) cover installation and operations.

## Scope rules

- Keep work within the current features documented in README.md. Future work is out of scope unless the user asks for it.
- Prefer the simplest thing that satisfies the requested change. Do not add services, packages, or abstractions it does not need.
- No PostgreSQL, Redis, Kubernetes, or message brokers. Storage is SQLite and Docker volumes.
- Preserve persisted state when upgrading from a supported release or the documented unversioned baseline. The one exception is the subprocess architecture release documented in README.md, which starts from a fresh installation without migration or import from previous releases. Version SQLite schema changes, provide ordered transactional migrations, and update the current schema for fresh installations. Set the supported predecessor in `release.json` when preparing a release.

## Stack

TypeScript (strict mode) on Node.js LTS, pnpm workspaces, Hono, Zod for input validation, grammY, Drizzle with SQLite, Docker, Playwright, Vitest, ESLint, and Prettier.

Use pnpm, not npm or yarn.

## Layout

Monorepo layout:

- `apps/server/` — Nimbot Server: authenticated administration panel, Telegram, agent registry, task routing, agent process management
- `apps/agent-host/` — runs as one process per agent: AI engine, tasks, workspace
- `apps/panel/` — administration UI
- `packages/` — shared code
- `infrastructure/docker/` — Dockerfiles
- `tests/` — integration and end-to-end tests

When a source directory becomes crowded enough that related files are hard to find, group them into subdirectories by feature or responsibility. Keep tests with the code they cover and use existing feature directories when they fit.

## Commands

- `pnpm install` — install dependencies
- `pnpm build` — compile all workspaces
- `pnpm lint` — ESLint and Prettier check (`pnpm format` to fix formatting)
- `pnpm typecheck` — type-check all workspaces
- `pnpm test` — run Vitest
- `docker build -f infrastructure/docker/nimbot.Dockerfile -t nimbot:local .` — build the application image

Run lint, type-check, and tests before finishing any change.

## Architecture constraints

- Nimbot runs as one application under one OS account. The Server starts each agent as a separate Agent Host child process. Do not add a separate runner service, separate OS accounts, or per-agent Unix users.
- Agent-generated shell commands run only in Agent Host processes, never in the Server process.
- An installation is a single trust domain that includes the Server and its agents. Agents can read each other's data and Server state, including secrets. Do not present Server-side approvals, grants, or rules as a security boundary against an agent with shell access, and keep this trust model accurate in the panel and documentation.
- Start Agent Hosts with an explicit minimal environment. Do not pass Server configuration or secrets to them. Keep one Host API token per agent and bind Agent Hosts to loopback.
- The Docker deployment runs the whole application as non-root in one container per installation, without the Docker socket.
- Agents can connect Telegram, Discord, or both after creation. Each connection uses a distinct bot and an owner-bound private chat. The authenticated web panel handles administration. Do not add a management bot. Do not introduce a shared selected-agent or `/use` workflow.
- Keep Telegram bot tokens and all polling connections in the Server process. Never hand them to Agent Host processes, model context, task events, or logs.
- Keep Telegram-specific code out of the agent runtime.
- Keep OpenCode-specific code behind the engine interface.
- Persist messages and tasks before executing them.
- Deleting an agent must not silently delete its persistent data.

## Conventions

- Write project-provided text (panel pages, built-in bot messages, CLI prompts, API errors), code, comments, tests, and documentation in English. Keep localization infrastructure out of scope.
- For model-generated replies, honor the user's requested language. Otherwise follow the language of the conversation and use English as the fallback.
- Do not create standalone manual validation guides or test run reports unless the user explicitly requests them. If the user needs to run commands to test something, provide the commands and instructions directly in chat.
- Never commit secrets. Configuration comes from environment variables; keep `.env.example` current once it exists.
- Add tests with new behaviour.
- When a change affects scope or architecture, update README.md in the same change.
- Commit or push only when the user asks.
- Match the existing commit message style: an English imperative subject without Conventional Commit prefixes, followed by a blank line and a short explanatory body.
- Include a `Co-Authored-By` trailer for the assisting AI, naming both the assistant and the model and using the provider's attribution email. Use the actual model identity available in the session; do not invent a model name or version.
