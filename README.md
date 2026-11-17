# Nimbot

**Your AI agents, on your own server.**

Nimbot is a self-hosted platform for creating and managing persistent AI agents through a web panel and talking to them through Telegram and optional Discord direct messages. Each agent runs in its own Docker container with a persistent workspace, a terminal, and a browser, and keeps working on long-running tasks while you are offline.

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

Fresh installations start with zero agents. Sign in to the panel and create each agent with a name, optional instructions, its owner's numeric Telegram user ID, and a token from a distinct bot created in BotFather. Nimbot verifies the bot, provisions the agent, and provides its Telegram link. Open **Configure AI providers** on that agent’s setup page. Save an API key for OpenAI, Anthropic, Google, or OpenRouter, or sign in to OpenAI with a ChatGPT device code. Each agent has its own credentials and login method; then send its bot a private message. The chat is linked automatically on first contact; no /start command is required.

No Telegram or per-agent environment variables are required. `.env` contains administrator authentication and trusted deployment settings; internal Agent Host credentials are generated automatically.

## Features

- Create, list, configure, start, stop, and delete agents through an authenticated web panel.
- Give each agent a distinct Telegram bot, owner-bound private chat, Docker container, and persistent workspace.
- Optionally connect a Discord bot and owner DM to the same agent, workspace, AI context, and durable task queue. Configure, replace, test, and remove the connection from the panel.
- Run terminal commands, read and write files, and browse public websites through OpenCode over ACP.
- Queue tasks durably, report progress, request owner approvals, and return results through the originating bot and chat.
- Cancel a running task without affecting other agents or blocking later queued tasks.
- Preserve conversations, files, configuration, and chat bindings across restarts; safely mark interrupted tasks instead of replaying potentially completed actions.
- Replace revoked bot tokens securely and retain persistent volumes by default when deleting an agent.

The panel uses one locally configured administrator account. Each agent has one Telegram owner; everyone else is ignored, including owners of other agents. There is no management bot, shared selected agent, or `/use` workflow. Tasks, progress, approvals, and results use their originating channel. Each optional Discord connection has its own configured owner and private DM binding.

### Telegram commands

| Command | Action |
|---|---|
| `/start` | Show an optional welcome message |
| `/help` | Show this agent's help |
| `/status` | Show chat and runtime status |
| `/schedules` | List this agent's scheduled tasks, next run times, and enabled state |
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
- **Agent Host:** one container per agent, running the AI engine, tools, tasks, workspace, and conversation state. An authenticated private API connects it to the server. Platform-specific code stays outside the runtime; OpenCode-specific code stays behind the engine interface.
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

Provider credentials are stored only in each agent's private engine-state volume. The panel forwards authentication operations over that agent's authenticated internal API; OAuth tokens never return to the server or browser. OpenAI supports an API key or ChatGPT device login; Anthropic, Google, and OpenRouter support API keys. The container must be running and idle to change authentication. Device login blocks new tasks for that agent as busy until it completes, is cancelled, or reaches its ten-minute local deadline; resend rejected tasks afterwards. Other agents remain independent. OpenCode renews OAuth tokens locally and still chooses the model automatically. Saving credentials does not verify balance or model access. Disconnecting removes the local credential without revoking it at the provider.

Both applications expose health checks and emit structured JSON logs with agent and task IDs. Prompts and results are not logged, and credentials are redacted. `NIMBOT_LOG=silent` disables logging. The panel reports bot polling, owner chat linking, container status, and authenticated Host readiness separately; readiness checks workspace access and busy state, not AI provider availability. Stopping an agent captures a task observation, and later refreshes confirm its persisted outcome when the Host is reachable.

## Security limitations

Nimbot is intended for trusted, single-server self-hosted deployments. Docker containers alone do not provide sufficient isolation for hostile multi-tenant workloads.

- The server's Docker Engine access is equivalent to root on the host. A compromised server or panel can compromise the host; the fixed provisioning template does not constrain an attacker controlling the server. Rootless Docker reduces this exposure where practical.
- Agent containers run as non-root with all capabilities dropped, `no-new-privileges`, CPU/memory/process limits, no additional swap, no published ports, and no Docker socket or server credentials. Each agent has its own network, volumes, and internal API token.
- Outbound network access is unrestricted, including reachable private addresses. Agent volume disk usage is not limited. Apply restrictions on the host if needed.
- Panel passwords use scrypt hashes. Sessions expire after eight hours and end on server restart. Cookies use HttpOnly and SameSite restrictions, with Secure cookies for HTTPS. State changes require same-origin checks; login is limited to five attempts per fifteen minutes. Remote access requires HTTPS.
- Telegram and Discord tokens stay on the server and never enter agent containers, model context, logs, or task events. Telegram messages and AI provider requests leave the server.

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

Default Vitest tests need no Docker, Telegram, or AI provider connection. A
multichannel integration test exercises simultaneous Telegram and Discord tasks
through the real Host API with a simulated engine, including shared context,
owner approvals, duplicate submissions, and server restart recovery. They cover authentication, CSRF, bot linking, owner authorization, routing, task persistence, cancellation, deduplication, and recovery. Panel browser tests use compiled assets and simulated services. Opt-in Docker tests verify lifecycle, isolation, response-loss recovery, and container hardening across recreation and restarts:

```sh
docker build -f infrastructure/docker/agent-host.Dockerfile -t nimbot-agent-host .
NIMBOT_TEST_DOCKER_IMAGE=$(docker image inspect nimbot-agent-host --format '{{.Id}}') pnpm test integration
```

`NIMBOT_TEST_DOCKER_SOCKET` optionally selects a different Unix socket. Tests create uniquely named resources and clean them up. CI runs lint, type checking, build, tests, and panel browser tests.

## Discord and outbound notifications

Outbound notifications use an internal server interface. The internal server
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

The server runs a Gateway per
configured agent, persists owner DMs, and admits them to the same FIFO and Host
runner as Telegram. Progress, results, errors, and approval buttons return to the
saved origin; `/stop` in the Discord owner DM cancels its running task. Approval
interactions verify the active task and owner before applying a decision.
Task services belong to agents independently of their channel connections.
Inbox admission is idempotent after restart; interrupted running tasks are not
replayed. The panel reports Discord conversation state and owner DM linking separately
from Telegram polling and Host readiness. Recovery tests cover session resume,
replayed events, cross-channel deduplication and context, and restored FIFO work.

## Future work

Scheduled tasks are in development. Cadence and time-zone calculation and the
SQLite schedule store are implemented and tested. The store shares `server.sqlite`
with the task queue: each occurrence records its history, enqueues its Telegram
task, and advances the next run in one transaction. It retains 20 history entries
per schedule and reads execution status from the task row. The scheduler component
checks due schedules every 30 seconds, skips unavailable agents and overlapping
runs, and records occurrences more than 10 minutes late as missed without replaying
a backlog. It starts after the bot connections and stops admitting work at server
shutdown. Scheduled runs use the agent's existing queue and conversation context;
only their final result is sent, with the saved schedule name. Approvals and `/stop`
use the owner's Telegram chat as usual. The first not-ready skip of a consecutive
streak uses the durable notification path. Deleting an agent removes its schedules
and run history before retiring its identity, while retaining queued task metadata
and preserving volumes unless data deletion was requested. The authenticated panel
API supports listing, creating, editing, pausing, resuming, removing, and running
schedules. Manual runs use the same admission and overlap checks, are recorded in
history, and leave the next timed occurrence unchanged. Schedule settings use form
fields `name`, `prompt`, `timeZone` (IANA), and `cadence` (a JSON object with its kind
and matching fields); interval anchors are assigned by the server. The panel's
Schedules page is linked from each agent and supports all schedule actions, a time
zone prefilled from the browser, and recent run history. It explains AI credit use
and Telegram delivery and warns when the owner chat is not linked. The owner can
list this agent's schedules with `/schedules`, even while its container is stopped.
Creating and editing schedules stays in the panel.

The following ideas are deferred, not supported features or delivery commitments:

- **AI engines:** native Codex, Claude Code, additional ACP providers, per-agent engine selection and switching.
- **Messaging:** WhatsApp, Slack, shared agents, groups/topics, file and media attachments, voice messages, management bots, and Telegram Managed Bots provisioning.
- **Nimbot messaging app:** a dedicated messaging app with [Matrix](https://matrix.org/) connectivity.
- **Agent capabilities:** agent-to-agent communication, delegation, shared tools, advanced memory retrieval, scheduled tasks, recurring automations, advanced approvals, and MCP integrations.
- **User experience:** advanced dashboards and analytics, web chat, richer configuration, templates, browser terminals, workspace browsing, conversation search, and additional panel accounts.
- **Operations:** multi-server and distributed execution, advanced monitoring, automated backups, image management, alternative runtimes, and stronger isolation.
- **Managed hosting:** a separate paid offering; hosted accounts, billing, subscriptions, public registration, public multi-tenant hosting, organizations, marketplaces, and automatic external infrastructure provisioning remain outside the self-hosted product's current scope.

Keep additions focused on the documented features unless an extension is explicitly requested. Prefer simple local components and persistent state over new services or infrastructure.

## License

Nimbot is released under the [Apache License 2.0](LICENSE).
