# Contributing to Nimbot

Thanks for helping. Nimbot is released under the [Apache License 2.0](LICENSE); by contributing you agree that your contributions are licensed under it.

## Before you start

- [README.md](README.md) is the source of truth for current scope, architecture, and future work. Extensions beyond the documented features need a discussion first.
- Keep changes small and aligned with the documented scope. Do not add services, packages, or abstractions the change does not need.
- Architecture constraints are firm: agent-generated commands run only in Agent Host subprocesses, never in the Server, Telegram bot tokens stay on the server, one bot per agent, no management bot and no `/use` workflow.

## Setup

Use Node.js 22.13 or newer and the pnpm version pinned in `package.json`. Install Docker to run the container tests.

```sh
pnpm install
pnpm build
```

### Native development

Install the supported OpenCode CLI and Chromium:

```sh
pnpm add --global --allow-build=@opencode/cli @opencode/cli@2.2.7
pnpm --filter @nimbot/agent-host exec playwright install --with-deps chromium
```

Copy `.env.example` to `.env`, run `pnpm panel:password`, and set
`PANEL_PASSWORD_HASH` to the generated hash. Run `pnpm dev` and open
`http://localhost:3000` (or your configured `PANEL_URL`). The command builds and
serves the panel, selects native mode, and detects the shared Chromium cache.
Re-run it after source changes. See [Panel development](#panel-development) for
hot reload.

Native mode requires a loopback panel address and uses `.nimbot-native/` by
default. Set `SERVER_STATE_DIR` to use another directory and
`PLAYWRIGHT_BROWSERS_PATH` to use a custom browser cache. To start a compiled
build with `NIMBOT_MODE=native pnpm start:server`, set
`PLAYWRIGHT_BROWSERS_PATH` explicitly.

Run `pnpm exec opencode --version` to verify the CLI on PATH. An older binary
can prevent the model catalog from loading and leave tasks queued. Look for
the failure in **Model and usage** or the `agent.model_check_failed` log event.

### Native startup troubleshooting

If `pnpm dev` reports `A fresh subprocess installation is required`, check
`SERVER_STATE_DIR` in `.env`. If it points to data from a previous installation,
such as `.nimbot`, change it to an unused directory. For example, use the native
default if you have yet to initialize it.

```dotenv
SERVER_STATE_DIR=.nimbot-native
```

Run `pnpm dev` again. Keep the old data directory. The subprocess release starts
with zero agents and has no migration or import path for the previous layout.

If port 3000 is already in use, set both `PANEL_PORT` and `PANEL_URL` to an
available port and open the matching URL in your browser.

```sh
PANEL_PORT=3001 PANEL_URL=http://localhost:3001 pnpm dev
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

Default Vitest tests use simulated services. The multichannel integration test
covers shared context, approvals, deduplication, and restart recovery over the
real Host API.

### Native integration tests

After building, run the native Server lifecycle gate with:

```sh
NIMBOT_TEST_NATIVE_BUILD=1 pnpm test tests/native-server.integration.test.ts
```

This gate starts the compiled Server and real Hosts, simulates Telegram transport,
and checks authenticated API creation, start/stop, recovery, concurrent Hosts and
retained data after removal. It requires no Docker or AI provider credentials;
CI runs it separately after the build and ordinary tests.

With OpenCode 2.2.7 on PATH, run the native engine gate:

```sh
NIMBOT_TEST_NATIVE_OPENCODE=1 pnpm test tests/native-opencode.integration.test.ts
```

It starts two real Hosts and OpenCode engines against a simulated local model.
Both engines must reach the model concurrently before either receives a response.
The gate verifies separate engine data and session IDs, then restarts both Hosts
and checks that each conversation resumes without the other agent’s history.
No AI provider credentials or paid model calls are used. CI installs the pinned
CLI into a temporary directory and runs this gate after the build.

After installing Chromium, run the browser profile gate:

```sh
NIMBOT_TEST_NATIVE_BROWSER=1 pnpm test tests/native-browser.integration.test.ts
```

It runs two real browser probes concurrently against a local web fixture. It verifies separate persistent cookies
and local storage across later CLI invocations, including executable paths with
spaces and shell metacharacters. CI runs this gate after installing Chromium.

### Container integration tests

Tests that need Docker are opt-in and skipped by default. To run them, build the application image:

```sh
docker build -f infrastructure/docker/nimbot.Dockerfile -t nimbot:local .
NIMBOT_TEST_APPLICATION_IMAGE=nimbot:local pnpm test tests/application-container.integration.test.ts tests/opencode-mcp.integration.test.ts tests/memory-fts5.integration.test.ts
```

The application-container gate covers a clean non-root installation, private
Host listeners, panel lifecycle operations, and health. It checks that Chromium
and the pinned OpenCode CLI are available, that workspaces and memory survive
container recreation and restore, and that agent deletion retains or purges data
according to the selected option.

The OpenCode MCP gate verifies the exact pinned OpenCode version, HTTP MCP
registration on new and restored ACP sessions, structured tool calls, cancellation,
model selection and usage, fresh delegated sessions, and memory retrieval after
reopening SQLite. All model traffic is simulated locally; the fixture runs as
non-root with external networking disabled. `tests/memory-fts5.integration.test.ts`
checks FTS5 search support in the same image.

The MCP and FTS5 gates accept `NIMBOT_TEST_DOCKER_SOCKET` to select a different Unix socket. Tests create uniquely named resources and clean them up.

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
