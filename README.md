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

A server-side Docker resource service now creates stopped Agent Hosts from a fixed template, requiring a SHA256 image ID or digest. It creates three labeled named volumes (workspace, OpenCode state, and task state) and a labeled per-agent bridge network; the registry volume reference identifies the workspace volume, and the other names derive from the same agent ID. The template fixes the non-root UID, dropped capabilities, no-new-privileges, CPU/memory/process limits, no extra swap, and no published ports. A persistence callback records resource references between steps. Partial failures retain resources for explicit recovery; existing containers require reconciliation rather than silent adoption. Removal verifies ownership labels, uses immutable container/network IDs, never forces a running container away, and preserves all volumes unless data deletion is explicitly requested. This service is wired to the server provisioning and cleanup APIs; panel creation/deletion remains pending. An opt-in Docker integration test exercises creation, start/stop, authenticated health, workspace persistence after recreation, retained volumes by default, and explicit data deletion against the fixed template. Run it with `NIMBOT_TEST_DOCKER_IMAGE=sha256:<local-image-id> pnpm test apps/server/src/container-lifecycle.integration.test.ts` after building the current Agent Host image; `NIMBOT_TEST_DOCKER_SOCKET` optionally selects a different Unix socket. It creates uniquely named test resources and cleans them up.

An internal provisioning coordinator now connects the registry to Docker creation and startup: it requires a linked bot, persists provisioning state before mutations and resource references before startup, records the start outcome, and checks authenticated Host health up to ten times before marking ready. Failures keep their references and volumes and require explicit inspection; concurrent attempts and externally managed agents are rejected. The coordinator now prepares a saved per-agent token and uses the fixed private Host endpoint derived from the agent ID. The server now initializes this coordinator when provisioning is explicitly configured; panel agent creation remains pending.

The Docker resource service accepts an optional trusted server-container reference, resolves its immutable Docker ID, and attaches that container to each new agent network before creating the Agent Host. The network reference is persisted before attachment, so attachment failures remain tracked and do not create an agent container. Removal disconnects the configured server without force before deleting the agent network; volumes are still retained by default. The opt-in integration test verifies authenticated server-to-agent access, the two network members, recreation, and cleanup against real Docker. The server entrypoint supplies this connection when provisioning is configured.

Host API credentials now use a separate private server-side store: 32 random bytes per agent, files with mode 600 in a mode-700 directory, and an opaque reference in SQLite migration 4. The provisioning coordinator saves the credential before Docker creation and reuses it after failure or restart. Missing, unreadable, or invalid saved credentials fail provisioning instead of silently rotating a token that an existing container may still use. Credential preparation failure prevents all Docker mutations. Tokens are separate from Telegram credentials and are absent from panel status metadata. The server opens this store only when provisioning is enabled.

Provisioning is now opt-in through `AGENT_HOST_IMAGE` (immutable SHA256 image ID/digest), `SERVER_CONTAINER_NAME`, and an absolute `DOCKER_SOCKET_PATH`. The server validates the complete configuration at startup, opens its Host credential store, and exposes `POST /api/agents/:id/provision` behind the existing administrator session and same-origin protections. The route uses only the agent ID; Docker settings come from trusted server configuration. The agent must already exist in the registry, have a linked bot and an allowlisted owner, and be pending, failed, or interrupted. Success returns its ID and ready state; failures return a generic conflict without Docker details or credentials. Provisioning does not automatically run on startup or retry uncertain mutations. The Docker Compose override forwards these settings and permits provisioning without the legacy configured-container control. Agent registration from the panel, full deletion workflow, dynamic task routing, and polling still need integration.

The authenticated `POST /api/agents/:id/resources/remove` endpoint now cleans up dynamically managed Docker resources. It requires a form field `confirm` matching the agent ID; volumes are retained unless `deleteData=true` is explicitly supplied. The server checks the owner allowlist, locks the provisioning state before Docker access, stops a running container with the existing interruption grace period, and removes the owned container and network. Success clears container/network references and returns the agent to pending, retaining the workspace-volume reference unless data was deleted. Failure keeps known references and marks the operation failed; a restart during cleanup leaves it interrupted. Externally managed agents are rejected. This is resource cleanup for recovery/reprovisioning, not full agent deletion: the registry entry, bot/chat binding, and credentials remain. Full panel deletion and agent registration remain pending.

Dynamically provisioned agents now support `POST /api/agents/:id/container` with form field `action=start` or `action=stop`; stopping also requires `confirm` matching the agent ID. The server applies administrator session, same-origin, and owner-allowlist checks. Actions require completed provisioning and a persisted immutable container ID, verify Docker ownership, persist a pending operation before inspection, and use the ten-second shutdown grace period. A pending action blocks other actions, provisioning, and resource cleanup through SQLite; completion or failure releases that guard, and restart marks pending actions interrupted. Docker success does not imply Host health readiness. The server-side create/start/stop/remove lifecycle is implemented; panel management remains a separate pending task.

When provisioning is enabled, the authenticated status API now includes a read-only `resources` inventory. The server lists all stopped/running containers, volumes, and networks carrying `io.nimbot.agent-id`, compares their immutable IDs or volume names and agent labels with registry references, and reports `missing` and `untracked` resources. Expected engine/task volumes derive from the fixed template alongside the saved workspace volume. A replacement resource or mismatched owner label appears as missing at its expected identity and untracked at its observed identity. Docker failures, volume warnings, or malformed inventories produce `unavailable`, without claiming resources are missing. Responses contain only agent ID, resource kind, and reference; no raw Docker metadata is exposed. These are observations during a refresh, so in-progress operations may produce transient differences. Reconciliation never adopts, recreates, or deletes resources automatically. Real-Docker integration validates the labeled listings against newly created resources.

The real-Docker lifecycle test now verifies kernel-enforced security before and after container recreation, in addition to the creation specification: UID 1000, zero inherited/permitted/effective/bounding/ambient capabilities on PID 1, `NoNewPrivs=1`, one CPU, 1 GiB memory, zero additional swap, and 256 processes through cgroup limits. It checks that only the three named-volume destinations are mounted, with no bind mounts, added capabilities, devices, Docker socket, or server credential environment variables. This completes the Phase 2 container-hardening task; restart recovery has separate acceptance tasks.

A separate opt-in real-Docker isolation test now creates two Agent Hosts using independently generated credentials from the private credential store and connects a server stand-in to both dedicated networks. It verifies that each network contains only its agent and the server, each agent has one network and no published ports, and the server reaches both APIs by Docker DNS and direct IP. The wrong agent token returns 401. Both cross-agent directions fail to reach the other API by name and IP even with the correct target token, while positive server-side checks confirm that the target is available. Run with `NIMBOT_TEST_DOCKER_IMAGE=sha256:<local-image-id> pnpm test apps/server/src/agent-isolation.integration.test.ts`; temporary containers, networks, volumes, credentials, and registry files are cleaned up.

Agent creation now has a server-side registration workflow and an authenticated same-origin `POST /api/agents` endpoint (enabled with provisioning). Form fields are `name`, optional `instructions`, `ownerId`, and the BotFather `token`; the server generates the resource-safe agent ID. It rejects non-allowlisted owners before Telegram access, verifies the bot through bounded `getMe`, writes a private credential file, and atomically records the linked bot, agent metadata, credential reference, and pending provisioning state before Docker is called. Duplicate bot identities, including legacy chat bindings, roll back registration and remove the candidate credential. Concurrent requests for the same bot register only one agent. Provisioning failures retain the registered agent, credential, resource references, and explicit setup state; the response exposes only the new ID and provisioning state. The panel now exposes this workflow through a creation form and a persistent setup-result page; dynamic bot polling and task routing remain pending.

With provisioning configured, the panel offers “Crear agente” and a single-column form for name, optional instructions, authorized owner Telegram ID, and BotFather token. Server validation preserves non-sensitive fields and clears the token on errors. Successful registration redirects to a setup page that reads persisted metadata on each refresh, distinguishing an available container from incomplete provisioning without resubmitting creation. The page explicitly states that new bots cannot receive tasks until dynamic polling is implemented. The form is hidden when provisioning is disabled. Chromium checks covered the creation/error flow, keyboard order, and overflow at desktop, 375px, and 320px widths; automated tests cover access control, origin checks, escaping, token non-disclosure, and incomplete setup.

The saved setup page now links to per-agent name/instruction editing at `/agents/:id/settings`. The form reuses the existing validation, escaping, limits, and save confirmation, and returns to that agent’s setup page. Server callbacks resolve the requested registry ID, enforce the owner allowlist, and update only that agent in SQLite. The bootstrap agent’s existing edit route remains available. Automated coverage verifies access/origin checks, validation, escaping, missing agents, and isolation between edits to two registered agents; Chromium checks cover editing and returning to the updated setup page. Per-agent token replacement and container start/stop controls are now available; explicit task interruption status in the panel remains pending, so the combined editing task stays open.

Each registered agent’s setup page now links to `/agents/:id/token`. The form identifies the selected agent, accepts only a replacement token for its already linked bot, and reuses bounded Telegram verification and private-file persistence. Server callbacks enforce the owner allowlist; routes require administrator authentication and same-origin submission. Errors never echo the submitted token and link back to the same agent. Successful saves redirect to a confirmation that states the restart requirement; neither the old nor new credential is rendered. Automated coverage uses real SQLite and private files to verify wrong-bot rejection and credential isolation between agents; Chromium checks cover rejection, retry, and confirmation. Dynamic polling and immediate application of replacements remain pending.

Provisioned agents now have start/stop controls on their setup page. Stop opens a confirmation naming the selected agent and explaining possible task interruption and data retention. Form submissions reuse the authorized, persisted per-agent Docker action workflow and redirect back to the same agent. On refresh the server inspects the saved container ID, checks the correct authenticated Host endpoint, and displays the last persisted operation independently of provisioning metadata. A stopped container no longer appears available merely because provisioning previously succeeded. Missing agents and unconfirmed/cross-origin requests are rejected; errors return to the selected agent without exposing Docker details. The panel does not yet verify the final state of a task after stopping: it reports the Docker operation and warns that task results may remain pending until the Host is available. Explicit task interruption observation remains pending, so the combined editing/control task stays open.

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
