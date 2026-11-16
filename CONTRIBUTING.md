# Contributing to Nimbot

Thanks for helping. Nimbot is released under the [Apache License 2.0](LICENSE); by contributing you agree that your contributions are licensed under it.

## Before you start

- [MVP.md](MVP.md) is the source of truth for scope, architecture, and phases. Work that is outside section 2.1 or in the post-MVP backlog needs a discussion first.
- Keep changes small and aligned with the current phase. Do not add services, packages, or abstractions the phase does not need.
- Architecture constraints are firm: agent-generated commands run only inside the agent's container, Telegram bot tokens stay on the server, one bot per agent, no management bot and no `/use` workflow.

## Setup

Requirements: Node.js 22.13 or newer, pnpm 10, and Docker for container tests.

```sh
pnpm install
pnpm build
```

## Checks

Run these before opening a pull request. CI runs the same commands.

```sh
pnpm lint        # ESLint and Prettier check (pnpm format fixes formatting)
pnpm typecheck
pnpm build       # Builds panel assets required by the server and its tests
pnpm test
pnpm exec playwright install chromium
pnpm test:panel
```

Tests that need Docker are opt-in and skipped by default. To run them, build the Agent Host image and pass its ID:

```sh
docker build -f infrastructure/docker/agent-host.Dockerfile -t nimbot-agent-host .
NIMBOT_TEST_DOCKER_IMAGE=$(docker image inspect nimbot-agent-host --format '{{.Id}}') pnpm test integration
```

They create uniquely named resources and remove them afterwards.

## Panel development

The panel lives in `apps/panel/` and uses Svelte 5, TypeScript, Vite, and daisyUI. Hono serves the production build from the same origin as the API. Run `pnpm build` before `pnpm start:server`; asset paths do not depend on the working directory.

For frontend development, start the configured server with its public origin set to Vite's address:

```sh
PANEL_URL=http://127.0.0.1:5173 PANEL_HOST=127.0.0.1 PANEL_PORT=3000 pnpm start:server
```

In a second terminal, run `pnpm dev:panel` and open `http://127.0.0.1:5173`. Vite proxies `/api` to `http://127.0.0.1:3000`, preserving the browser's Origin header so the server's existing CSRF check still applies. Use local HTTP for this development setup; production remote access requires HTTPS.

`pnpm test:panel` uses the compiled production assets and a local Hono fixture with simulated agent services; it does not connect to Docker, Telegram, or an AI provider. Rebuild after changing the panel or server. Browser tests run separately from Vitest in CI.

## Pull requests

- Add tests with new behaviour and keep `pnpm test` free of Docker and network access.
- Update MVP.md and README.md in the same change when scope or architecture changes.
- Write user-facing text, code, comments, and documentation in English.
- Never commit secrets. Configuration comes from environment variables; keep `.env.example` current.
- Commit messages use an English imperative subject without prefixes such as `feat:`, followed by a blank line and a short explanation of why.

## Reporting security issues

Do not open a public issue for a vulnerability. Contact the maintainers privately and include steps to reproduce. See the security limitations in MVP.md section 10 for the intended threat model.
