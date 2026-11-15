# Nimbot

**Your AI agents, on your own server.**

Nimbot is a self-hosted platform for creating and managing persistent AI agents through a web panel and talking to them through Telegram.

You install Nimbot on a Linux server with Docker Compose, sign in to a minimal administration panel, link a bot created in BotFather for each agent, and talk to each agent through its own distinct Telegram bot and private chat. Each agent runs in its own Docker container with a persistent workspace, a terminal, and a browser, and keeps working on long-running tasks while you are offline.

> **Project status:** Phase 1 in progress. Docker/ACP validation is complete. The initial Telegram server supports configuration validation, a user allowlist, and `/start` and `/help`; a password-protected status panel is available; the pre-configured agent has an owner-bound bot and chat activation; text tasks now route to the Agent Host and return split results to the owner’s activated chat; chat activation survives server restarts; live end-to-end validation remains pending. This README describes the intended `v0.1.0`; the full plan is in [MVP.md](MVP.md).

## What the MVP does

- Sign in to a minimal web panel to create, configure, start, stop, and delete agents
- Link each agent to a distinct BotFather-created bot by entering its token in the panel
- Chat with each agent through its own Telegram bot; tasks and `/stop` apply only to that agent
- Give each agent its own Docker container and persistent workspace
- Let agents run terminal commands, read and write files, and use a browser
- Send progress updates and final results back to Telegram
- Cancel a running task
- Keep conversations, files, and pending tasks across restarts
- Restrict access to an allowlist of Telegram user IDs

Out of scope for the MVP: advanced dashboards, web chat, management bots, other messaging channels, other AI engines, multi-server deployments, and hosted multi-tenant use. See the [post-MVP backlog](MVP.md#14-post-mvp-backlog).

## Architecture

One Nimbot Server serves the authenticated administration panel, maintains a distinct Telegram bot connection per agent, and manages one container per agent on the same machine. The panel uses a single locally configured administrator account. Each agent has one configured Telegram owner; there is no shared active-agent selection or `/use` command. Bot tokens are entered only in the authenticated panel and remain on the server. The owner must open each agent bot and press Start before it can send private notifications.

```text
  Web panel (admin)      Telegram agent bots A, B
          |                         |
          +------------+------------+
                       |
                       v
              +------------------+
              |   Nimbot Server  |
              |                  |
              | Telegram Adapter |
              | Agent Registry   |
              | Task Router      |
              | Container Manager|
              | SQLite Database  |
              +--------+---------+
                       |
                Docker Engine
                       |
          +------------+------------+
          |                         |
          v                         v
   +-------------+           +-------------+
   | Agent Host A|           | Agent Host B|
   |             |           |             |
   | OpenCode    |           | OpenCode    |
   | ACP Adapter |           | ACP Adapter |
   | Tools       |           | Tools       |
   | Workspace   |           | Workspace   |
   +------+------+           +------+------+
          |                         |
          v                         v
   Persistent Volume         Persistent Volume
```

- **Nimbot Server** serves the panel and its authenticated administration API, maintains each bot’s long-polling connection, validates the allowlist and agent owner, and routes messages by bot identity to the bound agent. It also handles agent registration and container lifecycle. Telegram tokens remain on the server and are never sent to agent containers. It never runs agent-generated commands on the host.
- **Agent Host** is one container per agent. It runs the AI engine, executes tasks, and owns the agent's workspace and conversation state.
- **Storage** includes bot identities, owners, chat bindings, credential references, and administrator/session state in SQLite, protected server-side bot secrets, and Docker volumes. No PostgreSQL, Redis, or message broker is required.

The server also persists the configured agent’s metadata and verified bot identity in its existing SQLite state database. A versioned migration preserves chat activation, and a bot already linked to another agent is rejected before polling starts. The registry stores a credential reference, not the Telegram token. The panel now includes “Editar agente” for its local name and optional instructions. Saved settings survive restarts; AGENT_NAME is used only to initialize a new registry record. Instructions are sent as context with each new task, and edits do not change an in-flight task. The Telegram bot profile is unchanged. The panel also offers “Reemplazar token del bot”: it validates a new token against the same Telegram bot, stores it in private files under SERVER_STATE_DIR/bot-secrets, and applies it at the next server restart. The registry keeps only the file reference. Keep the bootstrap TELEGRAM_BOT_TOKEN configured; a saved replacement takes precedence at startup. Include the private secret directory in protected server-state backups. Optional panel controls can start and stop the configured Agent Host, with a confirmation before stopping. Native runs enable them with DOCKER_SOCKET_PATH and AGENT_CONTAINER_NAME. Compose deployments can use the optional compose.docker.yaml override, setting the socket group ID in DOCKER_SOCKET_GID. The target must carry the io.nimbot.agent-id label matching AGENT_ID (the main Compose file sets it). Docker API v1.47 is required. Only the server receives the Docker socket, which grants powerful host-level control and must never enter agent containers. Volumes are retained. Container creation, deletion, and dynamic agent provisioning remain pending. Container start/stop operations now persist their latest action, outcome, and timestamp in SQLite before Docker mutation. The authenticated `/api/status` endpoint exposes this record. Pending operations become interrupted on server restart; this records uncertainty and does not automatically retry Docker actions. Docker inspection and Agent Host health remain the sources of current runtime status. When Docker controls are enabled, the authenticated `/api/status` endpoint also inspects the configured container on each request and reports `container` as `running`, `stopped`, `missing` (Docker returned 404), or `unavailable` (Docker failure, invalid inspection data, or a mismatched agent label). This field is omitted when Docker controls are disabled. Inspection does not recreate resources or retry mutations; the panel continues to show missing containers as unavailable. Dynamic provisioning remains pending.

The SQLite registry now also tracks provisioning state (`pending`, `provisioning`, `ready`, `failed`, or `interrupted`) and volume/network references through migration 3. Existing Compose-managed agents use `external` rather than claiming dynamic provisioning succeeded. Interrupted provisioning retains resource references across restarts and requires an explicit retry; ready state requires bot credentials and container, volume, and network references. The authenticated status API exposes this metadata. Registry operations for pending agents are implemented, but panel creation, Docker provisioning, cleanup, and blocking task routing for incomplete dynamic agents still need integration.

A server-side Docker resource service now creates stopped Agent Hosts from a fixed template, requiring a SHA256 image ID or digest. It creates three labeled named volumes (workspace, OpenCode state, and task state) and a labeled per-agent bridge network; the registry volume reference identifies the workspace volume, and the other names derive from the same agent ID. The template fixes the non-root UID, dropped capabilities, no-new-privileges, CPU/memory/process limits, no extra swap, and no published ports. A persistence callback records resource references between steps. Partial failures retain resources for explicit recovery; existing containers require reconciliation rather than silent adoption. Removal verifies ownership labels, uses immutable container/network IDs, never forces a running container away, and preserves all volumes unless data deletion is explicitly requested. This service is not yet wired to panel creation/deletion or the provisioning registry workflow. Server network attachment, per-agent API-token generation/storage, and provisioning readiness checks remain pending; the container lifecycle task stays open. An opt-in Docker integration test exercises creation, start/stop, authenticated health, workspace persistence after recreation, retained volumes by default, and explicit data deletion against the fixed template. Run it with `NIMBOT_TEST_DOCKER_IMAGE=sha256:<local-image-id> pnpm test apps/server/src/container-lifecycle.integration.test.ts` after building the current Agent Host image; `NIMBOT_TEST_DOCKER_SOCKET` optionally selects a different Unix socket. It creates uniquely named test resources and cleans them up.

## Technology

TypeScript on Node.js LTS, pnpm, Hono, grammY, Drizzle with SQLite, Docker, Playwright, and Vitest. The AI engine is [OpenCode](https://opencode.ai), driven through the Agent Client Protocol (ACP).

Compose now defines the server and one pre-configured Agent Host with CPU, memory, and process limits, non-root users, and named workspace/OpenCode state volumes. Only the panel port is published on loopback; the Agent Host API is available inside the Compose network. Its authenticated `/health` endpoint checks workspace access and reports whether the engine is busy. The internal API accepts `POST /tasks` with a JSON `prompt` and returns a task ID (202); `GET /tasks/:id` returns persisted state, output, and stop reason. The authenticated `GET /tasks/:id/events?after=<sequence>` endpoint returns ordered state events, including final output on completion. State changes and events commit atomically, events survive restarts, and legacy task records are backfilled on startup. The server uses a sequence cursor to retrieve subsequent events. All task endpoints require the internal bearer token. One task runs at a time; another submission receives 409. Tasks and prompts are committed to SQLite through Drizzle before OpenCode executes. A separate named volume retains task records, and unfinished records are marked interrupted on startup.

The API currently starts a fresh OpenCode session per task, limits execution to two minutes and stored output to 64,000 characters, and denies engine permission requests by default. Activated owner text now submits a task through the authenticated API. The server polls persisted state events and returns plain-text results in the same bot/chat, splitting long answers within Telegram’s limit without cutting surrogate pairs. Errors receive plain-language replies; ambiguous submissions are not retried automatically. Result polling stops after 150 seconds, with five-second HTTP request timeouts. Basic polling processes updates sequentially, so commands wait while a task runs. Live model-output events, a durable queue, cancellation, session continuity through the API, and user approvals remain pending. Live Telegram-to-OpenCode validation is still pending. No API task should be submitted to a native Agent Host process on the server machine: run it inside its Docker container.

The Agent Host image includes Playwright and headless Chromium. During Phase 0, OpenCode uses its container terminal to run the browser probe (`node /app/apps/agent-host/dist/browser-demo.js <url>`); no host browser or external MCP server is needed. The probe returns the page title and text. The demo waits up to two seconds for engine shutdown before forcing termination.

## Security

The MVP is intended for trusted, self-hosted use. The panel requires administrator authentication; remote access requires HTTPS. Telegram access requires both the allowlist and the agent’s configured owner. Deleting an agent retains its persistent volume unless data deletion is explicitly confirmed. Agent containers run as non-root with dropped capabilities, resource limits, a separate network and API token per agent, and no access to the Docker socket or server credentials.

Docker containers alone are not a sufficient isolation boundary for hostile or multi-tenant workloads. The Nimbot Server manages agent containers through the Docker Engine API, which is equivalent to root access on the host: protect the panel accordingly, and prefer rootless Docker where practical. Agent containers have unrestricted outbound network access, and agent volumes have no disk limit.

## Roadmap

| Phase | Goal |
|---|---|
| 0 | Validate OpenCode through ACP inside Docker |
| 1 | One pre-configured agent bot answering tasks, plus an authenticated status panel |
| 2 | Create and manage multiple agents and their bot bindings through the panel |
| 3 | Task queue, progress updates, cancellation, and browser |
| 4 | Recovery and hardening |
| 5 | Packaging and `v0.1.0` release |

Details and acceptance criteria for each phase are in [MVP.md](MVP.md).

## Inspiration

Nimbot takes architectural inspiration from [OpenBot](https://github.com/nightly-labs/openbot). It is an independent project and does not reuse OpenBot's source code, which is distributed under the PolyForm Noncommercial License 1.0.0.

## Contributing

Use Node.js 22.13 or newer. Run `pnpm install`, then `pnpm build`. Before submitting changes, run `pnpm lint`, `pnpm typecheck`, and `pnpm test`.

The Telegram server reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` (comma-separated numeric IDs) from environment variables or the root `.env`; `.env.example` lists the required settings. Start the compiled server with `pnpm start:server`. The current implementation still uses a single bot and handles private chats for allowlisted users. The panel reads `PANEL_PASSWORD_HASH` (generated with `pnpm panel:password` after building), `PANEL_URL` (default `http://localhost:3000`), `PANEL_HOST` (default `127.0.0.1`), and `PANEL_PORT` (default `3000`). A valid password hash is required at startup. Sessions expire after eight hours and are invalidated on restart; login allows five attempts per fifteen minutes. Remote access requires an HTTPS origin and a reverse proxy terminating TLS. The server reads `AGENT_HOST_URL` (default `http://agent-host:3001`, set automatically by Compose) and requires a separate `AGENT_HOST_TOKEN` of at least 32 characters without whitespace (generate one with `openssl rand -hex 32`). It passes only this internal API key and the workspace setting to the Agent Host, not Telegram or panel credentials. The image keeps its original ACP demo entrypoint; Compose overrides it to run the internal API.

The single pre-configured agent uses `AGENT_ID` and `AGENT_NAME`. Set `TELEGRAM_OWNER_USER_ID` to an allowlisted user; when the allowlist contains only one user, that user is the default owner. Other allowlisted users cannot access this agent. The owner activates its chat with `/start`, and `/status` reports activation and whether the agent is ready, busy, or stopped. A task sent while the agent is stopped or not ready is not submitted, and the bot says so. Activation persists in SQLite across server restarts and container recreation. Bindings match the agent ID, verified bot ID, and configured owner; a changed identity requires `/start` again. The panel shows the agent identity, owner, Telegram connectivity, activation, and the bot link; the panel verifies Agent Host readiness and busy state through its authenticated health API on refresh (three-second timeout). Unreachable, unhealthy, or invalid responses appear as disconnected; readiness does not validate AI provider availability. Agent creation still needs implementation. Users must open each agent bot and press Start before it can send notifications; delivery uses Telegram chat IDs, not phone numbers.

The server stores chat bindings in `SERVER_STATE_DIR/server.sqlite` (default `.nimbot/` for native runs). Compose sets this to `/home/node/.local/share/nimbot` and mounts the named `server-state` volume. The identity store uses Node’s built-in SQLite API; task persistence uses Drizzle. The database stores agent, bot, owner, and chat IDs, without bot tokens. A storage initialization failure prevents startup.

## License

Nimbot will be released under the Apache License 2.0.
