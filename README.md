# Nimbot

**Your AI agents, on your own server.**

Nimbot is a self-hosted platform for creating and managing persistent AI agents through a web panel and talking to them through Telegram. Each agent runs in its own Docker container with a persistent workspace, a terminal, and a browser, and keeps working on long-running tasks while you are offline.

> **Project status:** The MVP is complete. Installation through Docker Compose has been validated on macOS with Docker Desktop and on a clean Linux server.

The self-hosted software is free under [Apache 2.0](LICENSE); you pay separately for your infrastructure and AI provider. A separate paid plan where we host your bots is planned for later. Managed hosting is not available yet, and pricing and plan details are to be announced.

## Installation

With Docker and its Compose plugin installed and running, open a terminal and run:

```sh
curl -fsSL https://raw.githubusercontent.com/celeris-it/nimbot/main/install.sh | bash
```

The installer supports Linux and macOS, downloads the code, builds the images, generates configuration, and starts the panel. It asks for a password and offers localhost access or an existing HTTPS origin. No Node.js, pnpm, or Git is required on the host. Only one installation per Docker Engine is supported.

To uninstall while retaining data, run `bash "$HOME/.local/share/nimbot/uninstall.sh"`. Add `--purge-data` to explicitly delete agent and server data after confirmation. Images and source files are kept.

See [docs/INSTALL.md](docs/INSTALL.md) for a custom directory, HTTPS, BotFather linking, and AI provider authentication. [docs/OPERATIONS.md](docs/OPERATIONS.md) covers backup and restore, troubleshooting, and security limitations.

Fresh installations start with zero agents. Sign in to the panel and create each agent with a name, optional instructions, its owner's numeric Telegram user ID, and a token from a distinct bot created in BotFather. Nimbot verifies the bot, provisions the agent, and provides its Telegram link. Authenticate the AI provider inside each agent's container as described in the installation guide, then send its bot a private message. The chat is linked automatically on first contact; no /start command is required.

No Telegram or per-agent environment variables are required. `.env` contains administrator authentication and trusted deployment settings; internal Agent Host credentials are generated automatically.

## Features

- Create, list, configure, start, stop, and delete agents through an authenticated web panel.
- Give each agent a distinct Telegram bot, owner-bound private chat, Docker container, and persistent workspace.
- Run terminal commands, read and write files, and browse public websites through OpenCode over ACP.
- Queue tasks durably, report progress, request owner approvals, and return results through the originating bot and chat.
- Cancel a running task without affecting other agents or blocking later queued tasks.
- Preserve conversations, files, configuration, and chat bindings across restarts; safely mark interrupted tasks instead of replaying potentially completed actions.
- Replace revoked bot tokens securely and retain persistent volumes by default when deleting an agent.

The panel uses one locally configured administrator account. Each agent has one Telegram owner; everyone else is ignored, including owners of other agents. There is no management bot, shared selected agent, or `/use` workflow. Telegram remains the interface for tasks, progress, approvals, and results.

### Telegram commands

| Command | Action |
|---|---|
| `/start` | Show an optional welcome message |
| `/help` | Show this agent's help |
| `/status` | Show chat and runtime status |
| `/stop` | Cancel only this agent's running task |
| Text message | Queue a task for this bot's agent |

Agent creation, configuration, token replacement, container start/stop, and deletion are panel actions. Stopping a container safely interrupts active work; `/stop` cancels the task while leaving the container available.

## Architecture

One Nimbot Server serves the administration panel, maintains a separate Telegram long-polling connection per agent, and manages agent containers on the same machine.

```text
  Web panel (admin)      Telegram agent bots A, B
          |                         |
          +------------+------------+
                       |
                       v
              +------------------+
              |   Nimbot Server   |
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
   | OpenCode/ACP|           | OpenCode/ACP|
   | Tools       |           | Tools       |
   | Workspace   |           | Workspace   |
   +------+------+           +------+------+
          |                         |
          v                         v
   Persistent Volumes        Persistent Volumes
```

- **Nimbot Server:** authentication, bot credentials and connections, owner authorization, agent registration, task routing, container lifecycle, and diagnostics. Agent-generated commands never run on the host OS.
- **Agent Host:** one container per agent, running the AI engine, tools, tasks, workspace, and conversation state. An authenticated private API connects it to the server. Telegram-specific code stays outside the runtime; OpenCode-specific code stays behind the engine interface.
- **Panel:** Svelte 5, TypeScript, Vite, and daisyUI. Hono serves compiled assets and the same-origin API from one process. JavaScript is required; visible views refresh every five seconds and forms submit without document reloads.
- **Storage:** SQLite and Docker named volumes. No PostgreSQL, Redis, Kubernetes, message broker, or separate frontend service is required.

The stack uses strict TypeScript on Node.js, pnpm workspaces, Hono, grammY, Drizzle for task persistence, Node's built-in SQLite API for the registry, Docker, Playwright, Vitest, ESLint, and Prettier.

### Agent lifecycle

The server verifies BotFather tokens with Telegram and rejects bots already linked to another agent. Tokens remain in private server-side files; SQLite holds credential references. Replacing a token must preserve the bot's identity and takes effect after a server restart. Switching an existing agent to a different bot is outside the current scope.

Agent names and instructions persist across restarts. Instructions are snapshotted as context for each new task; edits do not modify running work or the Telegram bot's profile. Names allow up to 128 characters and instructions up to 4000 characters.

Compose enables provisioning using a fixed Docker template. `AGENT_HOST_IMAGE` is resolved to an immutable image ID at server startup without pulling; recreate the server after rebuilding the image. Docker Engine API v1.47 is required. Each agent gets three labeled volumes (workspace, engine state, task state), a private bridge network shared with the server, and a separate generated Host API credential.

Installer-managed resources carry an installation label so uninstall only removes resources belonging to that installation. Provisioning records state, resource references, and creation intentions before Docker mutations. Failed, cancelled, or interrupted setup retains its resources for explicit retry or cleanup and cannot execute tasks. Resource inventory reports missing, untracked, and uncertain resources without silently adopting, recreating, or deleting them. A lost Docker response is treated as uncertainty, not proof that an operation failed.

Deletion requires explicit confirmation and keeps volumes unless data deletion is separately selected. It stops polling and removes the local agent binding and credentials. Deleting the Telegram bot identity is a separate action in BotFather.

### Tasks and recovery

Incoming messages and task state are committed before execution. Each agent has a persistent FIFO queue and runs one turn at a time across its conversations; duplicate Telegram updates are deduplicated by bot ID and update ID. Commands remain responsive during execution. Progress, approval buttons, and results stay in the originating agent's chat, and long answers are split to fit Telegram limits. Approval callbacks check the owner, agent, and task; unanswered or undeliverable approvals are denied.

`TASK_TIMEOUT_SECONDS` bounds execution (10–3600 seconds, default 600). Failed or cancelled tasks free the queue for the next message. Task submissions and uncertain Docker mutations are never retried automatically. Transient reads and engine startup failures use bounded retries; a failed bot connection does not stop other bots.

The Agent Host saves its OpenCode session ID in its task-state volume and loads it for later turns. If a session cannot be loaded, it starts a new one. Running tasks become interrupted after a Host restart rather than being replayed. On server restart, saved agents reconnect with their existing owners and chat bindings, and unfinished operations are recorded as interrupted. Missing or stopped containers are detected rather than silently recreated.

Terminal and filesystem tools run through OpenCode inside the container. Browser automation uses headless Chromium through terminal execution with the bundled Playwright tooling; no external browser service is required. Client-side ACP filesystem and terminal capabilities remain disabled.

### Persistence and diagnostics

Server state includes agents, owners, instructions, verified bot identities, chat bindings, provisioning and container-operation metadata, and the durable task queue. Private `bot-secrets`, `discord-secrets`, and `host-secrets` directories live alongside the server SQLite database in `SERVER_STATE_DIR` (default `.nimbot/` for native runs). Compose mounts a named server-state volume. Each agent separately persists workspace files, OpenCode sessions and provider credentials, and task records/results. Back up all of these and `.env`; backups contain secrets.

Both applications expose health checks and emit structured JSON logs with agent and task IDs. Prompts and results are not logged, and credentials are redacted. `NIMBOT_LOG=silent` disables logging. The panel reports bot polling, owner chat linking, container status, and authenticated Host readiness separately; readiness checks workspace access and busy state, not AI provider availability. Stopping an agent captures a task observation, and later refreshes confirm its persisted outcome when the Host is reachable.

## Security limitations

Nimbot is intended for trusted, single-server self-hosted deployments. Docker containers alone do not provide sufficient isolation for hostile multi-tenant workloads.

- The server's Docker Engine access is equivalent to root on the host. A compromised server or panel can compromise the host; the fixed provisioning template does not constrain an attacker controlling the server. Rootless Docker reduces this exposure where practical.
- Agent containers run as non-root with all capabilities dropped, `no-new-privileges`, CPU/memory/process limits, no additional swap, no published ports, and no Docker socket or server credentials. Each agent has its own network, volumes, and internal API token.
- Outbound network access is unrestricted, including reachable private addresses. Agent volume disk usage is not limited. Apply restrictions on the host if needed.
- Panel passwords use scrypt hashes. Sessions expire after eight hours and end on server restart. Cookies use HttpOnly and SameSite restrictions, with Secure cookies for HTTPS. State changes require same-origin checks; login is limited to five attempts per fifteen minutes. Remote access requires HTTPS.
- Telegram tokens stay on the server and never enter agent containers, model context, logs, or task events. Telegram messages and AI provider requests leave the server.

See [security and recovery details](docs/OPERATIONS.md#security-limitations), including the limitations of restoring agents onto another Docker host.

## Development

Use Node.js 22.13 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Start the compiled server with `pnpm start:server`. Generate its administrator password hash with `pnpm panel:password`; `.env.example` documents deployment settings. See [CONTRIBUTING.md](CONTRIBUTING.md) for panel development and browser tests.

| Path | Responsibility |
|---|---|
| `apps/server/` | Panel API, Telegram, registry, routing, and container management |
| `apps/agent-host/` | AI engine, tasks, and persistent workspace inside each container |
| `apps/panel/` | Administration UI |
| `packages/` | Shared code when needed by multiple apps |
| `infrastructure/docker/` | Application Dockerfiles |
| `tests/` | Integration and panel end-to-end tests |
| `docs/` | Installation and operations guides |

Default Vitest tests need no Docker, Telegram, or AI provider connection. They cover authentication, CSRF, bot linking, owner authorization, routing, task persistence, cancellation, deduplication, and recovery. Panel browser tests use compiled assets and simulated services. Opt-in Docker tests verify lifecycle, isolation, response-loss recovery, and container hardening across recreation and restarts:

```sh
docker build -f infrastructure/docker/agent-host.Dockerfile -t nimbot-agent-host .
NIMBOT_TEST_DOCKER_IMAGE=$(docker image inspect nimbot-agent-host --format '{{.Id}}') pnpm test integration
```

`NIMBOT_TEST_DOCKER_SOCKET` optionally selects a different Unix socket. Tests create uniquely named resources and clean them up. CI runs lint, type checking, build, tests, and panel browser tests.

## Future work

Outbound notifications are under development in `TODO.md`. The internal server
interface and Telegram adapter reuse the agent's verified bot connection and
owner chat, split long text, and report uncertain sends without retrying them.
The Discord HTTP adapter resolves owner-only DMs, splits text, suppresses mentions,
and honors rate-limit cooldowns without retrying uncertain sends. Both adapters
remain internal. Discord configuration now has server-side bot verification,
private credential files, SQLite metadata with string IDs, and authenticated
configuration API routes and panel forms to connect, replace, and remove a bot.
A durable notification store and delivery wrapper now record intent and sanitized
results, deduplicate request IDs, and mark in-flight sends uncertain after restart
without replaying them. Only a content hash is stored, not notification text.
The authenticated Discord test API uses this durable path with a fixed test
message. It accepts only a request ID, resolves the saved owner on the server,
and allows five new notification attempts per minute per agent across channels.
Provider rate-limit responses count as attempts; locally blocked requests do not
extend the window. The quota persists across restarts.
Automatic task delivery is independent of this limit. The panel can send a test
and check its last request without resending it. Uncertain delivery is shown
explicitly; check your DMs before starting a new test. Configuration changes invalidate previously resolved delivery targets. Remove a Discord
connection before retiring its agent. Automatic task delivery continues through
its existing independent path.

A server-side Discord Gateway transport is under development for the next phase.
The server starts a Gateway per configured agent, filters owner DMs, and handles
heartbeat and session recovery. Configuration replacement, removal, and shutdown
close the corresponding connection independently. Incoming messages atomically
link the owner DM and enter a SQLite inbox with deduplication by bot and message
ID. Stale connection identities are rejected. Discord messages are stored but
not yet executed. Queue claiming and draining now serialize by agent across
conversations while preserving the original delivery destination. Discord task
origins can now be stored as string IDs with platform-specific deduplication
and claimed in the same FIFO as Telegram tasks. The shared queue processor
now executes both origins through one callback and routes progress, results,
and cancellation by the saved origin. Inbox admission and bot lifecycle
integration with this processor remain pending. Discord approval keys now bind
the active task, agent, bot, owner, channel, and message, and expire or become
unusable after restart. The Gateway filters owner button interactions; button
delivery and interaction acknowledgments are not wired yet.

The following ideas are deferred, not supported features or delivery commitments:

- **AI engines:** native Codex, Claude Code, additional ACP providers, per-agent engine selection and switching.
- **Messaging:** WhatsApp, Slack, Discord, shared agents, groups/topics, file and media attachments, voice messages, management bots, and Telegram Managed Bots provisioning.
- **Agent capabilities:** agent-to-agent communication, delegation, shared tools, advanced memory retrieval, scheduled tasks, recurring automations, advanced approvals, and MCP integrations.
- **User experience:** advanced dashboards and analytics, web chat, richer configuration, templates, browser terminals, workspace browsing, conversation search, and additional panel accounts.
- **Operations:** multi-server and distributed execution, advanced monitoring, automated backups, image management, alternative runtimes, and stronger isolation.
- **Managed hosting:** a separate paid offering; hosted accounts, billing, subscriptions, public registration, public multi-tenant hosting, organizations, marketplaces, and automatic external infrastructure provisioning remain outside the self-hosted product's current scope.

Keep additions focused on the documented features unless an extension is explicitly requested. Prefer simple local components and persistent state over new services or infrastructure.

## Inspiration

Nimbot takes architectural inspiration from [OpenBot](https://github.com/nightly-labs/openbot). It is an independent project and does not reuse OpenBot's source code, which is distributed under the PolyForm Noncommercial License 1.0.0.

## License

Nimbot is released under the [Apache License 2.0](LICENSE).
