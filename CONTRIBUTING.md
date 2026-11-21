# Contributing to Nimbot

Thanks for helping. Nimbot is released under the [Apache License 2.0](LICENSE); by contributing you agree that your contributions are licensed under it.

## Before you start

- [README.md](README.md) is the source of truth for current scope, architecture, and future work. Extensions beyond the documented features need a discussion first.
- Keep changes small and aligned with the documented scope. Do not add services, packages, or abstractions the change does not need.
- Architecture constraints are firm: agent-generated commands run only in Agent Host subprocesses, never in the Server, Telegram bot tokens stay on the server, one bot per agent, no management bot and no `/use` workflow.

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

Tests that need Docker are opt-in and skipped by default. To run them, build the application image:

```sh
docker build -f infrastructure/docker/nimbot.Dockerfile -t nimbot:local .
NIMBOT_TEST_APPLICATION_IMAGE=nimbot:local pnpm test tests/application-container.integration.test.ts tests/opencode-mcp.integration.test.ts tests/memory-fts5.integration.test.ts
```

They create uniquely named resources and remove them afterwards.

## Panel development

The panel lives in `apps/panel/` and uses Svelte 5, TypeScript, Vite, and daisyUI. Hono serves the production build from the same origin as the API. Run `pnpm build` before `pnpm start:server`; asset paths do not depend on the working directory.

For frontend development, start the configured server with its public origin set to Vite's address:

```sh
NIMBOT_MODE=native PANEL_URL=http://127.0.0.1:5173 PANEL_HOST=127.0.0.1 PANEL_PORT=3000 pnpm start:server
```

In a second terminal, run `pnpm dev:panel` and open `http://127.0.0.1:5173`. Vite proxies `/api` to `http://127.0.0.1:3000`, preserving the browser's Origin header so the server's existing CSRF check still applies. Use local HTTP for this development setup; production remote access requires HTTPS.

`pnpm test:panel` uses the compiled production assets and a local Hono fixture with simulated agent services; it does not connect to Docker, Telegram, or an AI provider. Rebuild after changing the panel or server. Browser tests run separately from Vitest in CI.

The panel's reusable UI lives in `apps/panel/src/components/` and is exported from its `index.ts`. It includes actions, surfaces, metrics, status badges, initial avatars, filter groups, search fields, empty states, progress meters, a generic snippet-based table, and an activity feed. Table rows require a stable `rowKey`; activity entries require an ISO timestamp. The table and activity feed are available for future screens and do not add product features by themselves.

Use the `nimbot` dark theme with `dark` and `muted` surfaces defined in `panel.css`, with daisyUI's semantic color tokens. The Manrope variable font is bundled locally; the panel makes no external font requests. Summaries derive from the existing status API: completed setup and Telegram polling must not be presented as proof of runtime availability. Search, filters, and the selected preview stay local to the dashboard.

## Pull requests

- Add tests with new behaviour and keep default `pnpm test` runs free of Docker and external network services.
- Update README.md in the same change when scope or architecture changes.
- Write user-facing text, code, comments, and documentation in English.
- Never commit secrets. Configuration comes from environment variables; keep `.env.example` current.
- Commit messages use an English imperative subject without prefixes such as `feat:`, followed by a blank line and a short explanation of why.

## Reporting security issues

Do not open a public issue for a vulnerability. Contact the maintainers privately and include steps to reproduce. See the [security limitations in README.md](README.md#security-limitations) for the intended threat model.
