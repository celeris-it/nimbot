# Nimbot — MVP Specification

**Version:** 0.1.0  
**Status:** Phase 1 in progress  
**License:** Apache License 2.0  
**Deployment:** Self-hosted  
**Interfaces:** Web panel for administration; Telegram for agent conversations  
**Primary AI Engine:** OpenCode (ACP)

---

## 1. Overview

Nimbot is a self-hosted platform for creating, running, and managing persistent AI agents through a local web panel, with agent conversations delivered through Telegram.

Users install Nimbot on their own servers and interact with their agents through Telegram.

Each agent has its own Telegram bot, private chat, identity, instructions, conversations, persistent workspace, and execution environment. An authenticated web panel handles agent administration; users send tasks directly to each agent’s bot. There is no management bot.

Agents can execute commands, modify files, browse the web, and perform long-running tasks without requiring users to remain connected.

The MVP focuses on delivering a reliable, extensible, single-server installation.

### 1.1 MVP Goal

A user should be able to:

1. Install Nimbot on a Linux server using Docker Compose.
2. Sign in to the administration panel and link a distinct Telegram bot for each agent.
3. Create and manage multiple AI agents through the panel.
4. Assign a dedicated execution environment to each agent.
5. Send tasks in each agent bot’s private chat, with no shared active-agent selection.
6. Allow agents to execute terminal commands, manipulate files, and use a browser.
7. Receive progress updates and task results.
8. Stop and restart agents without losing persistent data.
9. Recover conversations and pending tasks after application restarts.

### 1.2 Success Criteria

The MVP is complete when:

- Nimbot can be installed with documented Docker Compose instructions.
- The authenticated panel can create, list, configure, start, stop, and delete agents.
- Unauthenticated users cannot access agent administration or credentials.
- Every agent has a distinct Telegram bot and private conversation.
- Tasks, progress, approvals, and results stay in the originating agent bot’s chat.
- At least two agents can operate independently.
- Each agent has a persistent workspace.
- OpenCode can execute tasks through ACP.
- Terminal, filesystem, and browser tools work.
- Conversations survive restarts.
- Pending tasks can be recovered or safely marked interrupted.
- Agent execution can be cancelled.
- Unauthorized Telegram users cannot control the installation.
- The system can recover from a server or container restart without losing committed state.

---

## 2. Scope

### 2.1 Included in MVP

- Self-hosted deployment
- Docker Compose installation
- Minimal authenticated web administration panel
- Telegram integration with one distinct bot per agent
- Manual bot creation in BotFather and secure token linking through the panel
- Private one-to-one chats with explicit bot-to-agent bindings
- Multiple persistent agents
- OpenCode integration through ACP
- Dedicated Docker execution environment per agent
- Persistent filesystem
- Terminal execution
- Browser automation
- Agent instructions and configuration
- Conversation history
- Task queues
- Task cancellation
- Basic progress reporting
- Agent lifecycle management
- SQLite persistence
- Basic logging and diagnostics
- Local configuration and secrets management

### 2.2 Excluded from MVP

- Advanced dashboards, analytics, and a web chat interface
- Management bots and Telegram Managed Bots provisioning
- Public registration, multiple panel accounts, and shared agent administration
- Mobile application
- WhatsApp integration
- Slack and Discord integrations
- Multiple AI engine support
- Billing and subscriptions
- Organization accounts
- Kubernetes
- Distributed execution across multiple servers
- Horizontal scaling
- Advanced agent collaboration
- Marketplace or plugin store
- Hosted account management
- Public multi-tenant hosting
- Automatic infrastructure provisioning outside the local server

---

## 3. Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js LTS |
| Package Manager | pnpm |
| HTTP Framework and Administration Panel | Hono; minimal server-served UI |
| Telegram Bot | grammY |
| AI Engine | OpenCode |
| Agent Protocol | Agent Client Protocol (ACP) |
| Database | SQLite |
| ORM | Drizzle |
| Container Runtime | Docker |
| Browser Automation | Playwright |
| Testing | Vitest |
| Deployment | Docker Compose |

The MVP should avoid unnecessary external infrastructure dependencies.

Redis, PostgreSQL, Kubernetes, and external message brokers are not required.

---

## 4. Architecture

Nimbot uses a local server architecture with a central application and independent agent execution environments.

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

### 4.1 Nimbot Server

The Nimbot Server is responsible for:

- Serving the administration panel and enforcing administrator authentication
- Telegram communication through each agent’s bot
- Bot credentials, long-polling connections, and bot-to-agent bindings
- Agent registration
- Agent configuration
- Task routing
- Container lifecycle management
- User authorization
- Task status tracking
- System configuration
- Logging and diagnostics

The server must not execute agent-generated shell commands directly on the host operating system.

### 4.1.1 Administration panel

The MVP has one administrator account per self-hosted installation. Credentials are configured locally before startup; there is no public registration, password recovery by email, or external identity provider. The panel and its API are served by the Nimbot Server, without a separate frontend service.

The panel supports only:

- Sign in and sign out.
- List agents, their runtime and bot connection states, and links to open their Telegram chats.
- Create an agent with a name, optional instructions, the owner's numeric Telegram user ID, and a bot token created in BotFather.
- Edit the name and instructions, and replace a revoked bot token. Instruction changes apply on the next task, without rewriting a running task.
- Start and stop an agent's container. Stopping an agent safely interrupts an active task and records its status; it is distinct from Telegram `/stop`, which cancels only the current task.
- Delete an agent with explicit confirmation and a separate explicit choice to delete its persistent data. Retaining the volume is the default.

Authentication and authorization protect every administration page and API endpoint. Passwords are stored as hashes; sessions use expiring HttpOnly cookies, Secure cookies when served over HTTPS, and SameSite restrictions. State-changing requests have CSRF protection and login attempts are rate limited. Remote deployment requires HTTPS; local access may use loopback HTTP. Bot tokens are accepted only through authenticated requests, masked after saving, and never returned to the browser in subsequent responses.

Web task chat, terminal access, file browsing, analytics, and additional panel accounts are deferred. Telegram remains the interface for tasks, progress, results, and approvals.

### 4.1.2 Telegram routing

- Each agent has exactly one distinct Telegram bot. A bot cannot be bound to multiple agents.
- A single Nimbot Server maintains a grammY long-polling connection for each bot; agent containers do not connect to Telegram.
- Routing resolves the receiving bot ID to its bound agent, then checks the Telegram sender against the installation allowlist and the agent's configured owner. Each agent has one Telegram owner for the MVP; shared agents are deferred.
- The server records the private chat ID after the owner starts the agent bot. Tasks, progress, approvals, cancellations, and final responses use that same bot and chat. Telegram delivery uses chat IDs, not phone numbers.
- There is no global selected agent and no `/use` command. Different agents have separate chats, histories, and queues.
- Telegram bot tokens stay in protected server-side secret storage and never enter agent containers, model context, logs, or task events. SQLite stores bot identity and a reference to its credential.
- Users must open each agent bot and press Start before it can send private notifications. The panel distinguishes container readiness, bot connectivity, and chat activation.

### 4.1.3 Agent creation and bot linking

1. The administrator creates a bot in BotFather and obtains its token.
2. In the authenticated panel, the administrator enters an agent name, optional instructions, the owner's numeric Telegram user ID, and the token. The Telegram owner must be allowlisted.
3. The server validates the token with Telegram, verifies the bot identity, rejects an already-bound bot, and persists pending setup with a server-side credential reference before provisioning.
4. Nimbot provisions the Agent Host and starts polling its bot. The panel shows progress, the resulting status, and the bot's chat link; incomplete or failed agents cannot execute tasks.
5. The owner opens the bot and presses Start. Only that authorized owner can activate the private-chat binding and send tasks.

Retries must not create multiple agents or bind the same bot twice. Failed or cancelled provisioning records what was created and allows an explicit retry or cleanup. Deleting an agent stops its bot connection and removes its local binding and credential; it does not delete the Telegram bot identity. The panel explains that Telegram identity deletion is handled separately in BotFather. Replacing a token verifies the same bot identity; switching an existing agent to a different bot is deferred.

Telegram references: [BotFather](https://core.telegram.org/bots/features#botfather) and [bot conversation restrictions](https://core.telegram.org/bots#how-are-bots-different-from-humans).

### 4.2 Agent Host

Each agent runs inside its own Docker container.

An Agent Host is responsible for:

- Running the AI engine
- Managing provider sessions
- Executing agent tasks
- Providing access to tools
- Maintaining the workspace
- Persisting execution state
- Reporting events and results
- Handling cancellation

The host communicates with the Nimbot Server through an authenticated internal API.

### 4.3 Persistence

The Nimbot Server maintains a SQLite database containing:

- Administrator account and panel session state
- Agents
- Agent configurations
- Telegram user permissions
- Agent owners, Telegram bot IDs and usernames, credential references, and private-chat bindings
- Pending bot setup and activation state
- Telegram conversation routes keyed by bot ID and chat ID
- Task metadata
- Container metadata
- Application settings

Each Agent Host maintains its own persistent state:

- Conversation history
- Provider sessions
- Task execution events
- Workspace files

The Agent Host may use its own SQLite database for local execution state.

Persistent volumes must survive container recreation.

---

## 5. Repository Structure

```text
nimbot/
├── apps/
│   ├── server/
│   └── agent-host/
│
├── packages/
│   ├── contracts/
│   ├── provider-acp/
│   └── channel-telegram/
│
├── infrastructure/
│   └── docker/
│
├── tests/
│   ├── integration/
│   └── e2e/
│
├── docs/
│
├── compose.yaml
├── package.json
├── pnpm-workspace.yaml
├── AGENTS.md
├── MVP.md
├── README.md
└── LICENSE
```

Add a new package only when two apps need to share the code.

---

## 6. Phase 0 — Technical Validation

**Goal:** Prove that OpenCode can be driven through ACP inside Docker before building anything around it.

### Tasks

- [x] The monorepo is set up with pnpm, TypeScript strict mode, ESLint, Prettier, and Vitest.
- [x] An Agent Host Docker image runs OpenCode as a non-root user.
- [x] A minimal ACP client can start a session, send a prompt, and receive streaming output.
- [x] OpenCode can edit a file and run a terminal command in the workspace.
- [x] A browser task works, and the way OpenCode reaches the browser is decided and documented.
- [x] Session resumption after a process restart and cancellation of a running prompt are tested.
- [x] A short write-up lists what OpenCode already provides (sessions, history, tools) and what Nimbot must build.

The client supports capability-checked session loading and cancellation. Docker validation with OpenCode 1.19.5 confirmed file writes, terminal execution, persistent workspaces and history, session loading after container recreation, cancellation, and a new turn after cancellation. Browser validation confirmed that OpenCode can launch headless Chromium through its terminal using the bundled Playwright probe and summarize https://example.org. The browser runs inside the Agent Host; no external MCP server is required. The demo bounds engine shutdown with a two-second grace period before SIGKILL.

OpenCode provides sessions, history replay, filesystem and terminal tools. Nimbot must provide Telegram routing and authorization, durable task state, container lifecycle, progress delivery, and user approvals. Client-side ACP filesystem and terminal capabilities remain disabled; tools run through OpenCode inside the container. Browser automation uses terminal execution rather than a dedicated ACP browser capability.

### Acceptance Criteria

- OpenCode executes a task through ACP inside Docker, with responses and tool events observable.
- The workspace persists after a container restart.
- Unsupported or missing ACP capabilities are documented.

---

## 7. Phase 1 — One Agent over Telegram

**Goal:** A single, pre-configured agent answers over Telegram, end to end.

There is no dynamic agent creation in this phase. One Agent Host container is defined in `compose.yaml`, and one pre-configured agent bot is bound to it. A minimal authenticated panel shows that agent’s status and Telegram link. This validates the administration/conversation split before adding provisioning in Phase 2.

### Tasks

- [x] The Nimbot Server starts, validates its configuration, and connects to Telegram with long polling.
- [x] Only allowlisted Telegram user IDs get a response; everyone else is rejected.
- [x] Locally configured administrator authentication, login/logout, protected panel/API routes, session expiry, CSRF protection, and login rate limiting work.
- [x] The panel lists the pre-configured agent, its status, bot connectivity and activation state, and a link to its Telegram chat.
- [x] The pre-configured agent bot token and owner ID are validated and explicitly bound to that agent.
- [x] One Agent Host container runs with a persistent workspace volume.
- [x] The agent bot is bound to that Agent Host and the authorized owner’s private chat after `/start`.
- [x] The server sends tasks to the Agent Host and receives events over an authenticated internal API.
- [x] A text message in the agent bot’s chat becomes an OpenCode task, and the final answer is delivered by that same bot to that chat.
- [x] Long answers are split to fit Telegram's message length limit.
- [x] Errors are reported to the user in plain language.

Current implementation: the server validates one Telegram token and a non-empty user allowlist, starts grammY long polling, and handles `/start` and `/help` in private chats. The pre-configured agent has an ID, name, and Telegram owner. An authenticated Hono panel shows that binding, Telegram connectivity, the bot link once connected, chat activation after the owner sends `/start`, and Agent Host readiness through authenticated health checks. The panel and authenticated status API now query the internal authenticated health endpoint on each refresh, with a three-second timeout and redirects disabled. They report Agent Host readiness (workspace writable), busy state, or unavailability independently of Telegram connectivity. Readiness does not verify AI provider availability. Telegram task routing is now implemented; live end-to-end validation remains pending.

The panel uses a locally configured scrypt password hash, opaque server-side sessions with an eight-hour expiry, HttpOnly/SameSite cookies (Secure for HTTPS), same-origin validation on all POST requests, and a global limit of five login attempts per fifteen minutes. Sessions and rate-limit state are in memory for this phase; restarting the server signs administrators out. The panel stays available with a disconnected status if Telegram startup fails. Authentication, logout, expiry, CSRF, rate limits, and protected API access have automated coverage; login/logout and responsive layouts were checked in Chromium with a simulated bot status. Live Telegram validation previously confirmed that an allowlisted user receives the welcome and setup notices. Owner checks apply in addition to the allowlist, so another allowlisted user cannot activate or use this agent. `/help` and `/status` do not activate the chat. Activation is now persisted in a server-side SQLite database, keyed by agent ID and checked against the verified Telegram bot ID and configured owner. The owner must activate again if that identity no longer matches. `/start` commits the binding before confirming activation; failed writes do not activate a new chat. The server restores panel activation after Telegram verifies its bot identity. A named server-state volume retains the database across container recreation. This small identity store uses Node’s built-in SQLite API (Node 22.13 or newer), without adding a database dependency; task storage continues to use Drizzle. Panel sessions remain in memory. Compose defines both applications, named persistent workspace and engine-state volumes, non-root execution, resource limits, and an unpublished Agent Host API. The authenticated `/health` endpoint checks workspace access and reports busy/idle engine state. The server image and its panel health check are included. Docker validation confirmed non-root execution, API rejection without authentication, successful server-to-host health requests, and workspace file retention after container recreation. This does not validate task execution through the API. The internal API now accepts one task at a time with `POST /tasks` and returns persisted state and output through `GET /tasks/:id`. Prompts and initial state are committed to SQLite through Drizzle before execution, and task state has its own persistent volume. Concurrent submissions receive 409. Execution has a configurable timeout (`TASK_TIMEOUT_SECONDS`, default 600) and a 64,000-character output limit; leftover accepted/running records become interrupted on startup. Permission requests are sent to the owner for approval and denied when unanswered, unauthorized, or if the owner cannot be reached. Docker validation with a free OpenCode model confirmed that a server-container request completes a prompt and that its result remains queryable after Agent Host recreation. The server now submits activated owner text to this API and polls persisted state events until completion, returning plain-text results through the originating bot and chat. Replies are split at 4096 UTF-16 code units without breaking surrogate pairs. Busy, failed, interrupted, unavailable, and timeout states receive plain-language responses; ambiguous submissions are never retried automatically. Polling is bounded by the task timeout plus thirty seconds, with five-second request timeouts. Messages are saved as queued tasks and run one at a time per conversation, so commands such as `/status` and `/stop` stay responsive while a task runs. Tool-use progress, `/stop` cancellation, and owner approvals through inline buttons are implemented; Session continuity across tasks is described in Phase 4. Chat activation now survives server restarts; the state event API is implemented. New automated coverage was added. Lint and independent smoke checks passed. A strict TypeScript check of both apps through the compiler API also passed and uncovered two test typing errors, now corrected. The dependency installation issue that previously blocked standard checks is no longer blocking this workspace; lint, typecheck, build, and the full Vitest suite now pass. Live Telegram-to-OpenCode validation remains pending. State transitions and their events are committed atomically through Drizzle/libSQL batch transactions. The authenticated `GET /tasks/:id/events?after=<sequence>` endpoint returns ordered events with a monotonically increasing sequence and final output/stop reason on completion. The server advances its cursor after each event. An additive migration backfills the latest state of legacy tasks; restart recovery records interruption once. Events currently describe state transitions, not live model output. Independent checks passed against real SQLite, Hono, and the server client for completion, cursors, authentication, restart recovery, and legacy migration.

### Acceptance Criteria

- An authorized owner starts the agent bot, sends a programming task in its private chat, and receives the result there.
- The administrator can sign in to the panel, inspect the agent, and open its Telegram chat. Unauthenticated requests cannot access the panel or administration API.
- An unauthorized user is rejected.
- Files the agent created are still there after the container restarts.

---

## 8. Phase 2 — Multiple Agents

**Goal:** Create and manage agents from the authenticated panel, each with its own Telegram bot, private conversation, container, and persistent volume.

Initial registry implementation: the server now keeps the configured agent's name and owner, verified bot ID and username, and a credential reference in the existing server SQLite database. A versioned transactional migration adds the registry without changing chat activation records. Bot identity is verified with Telegram and recorded before polling starts; duplicate bot assignments, including legacy chat bindings, are rejected. Initial tokens come from the environment; replacement tokens are stored in private server-side files and only their references enter the registry. The authenticated panel now edits the configured agent’s local name (up to 128 characters) and optional instructions (up to 4000 characters). Saved values survive restart and take precedence over the initial AGENT_NAME; instructions are snapshotted into each new task prompt as context, without modifying in-flight tasks. This does not rename the Telegram bot profile or provide a separate engine system-message channel. Container references are not configurable yet. The existing small Node SQLite identity store is reused; dynamic registration, live token application without restart, credential management for additional bots, and container provisioning remain pending. The authenticated panel now verifies replacement tokens using Telegram getMe and accepts only the currently registered bot ID. A fresh credential file is written with mode 600 under the server-state bot-secrets directory (mode 700), and its reference is recorded only after the write succeeds. Failed database writes remove the candidate file. Saved credentials take precedence over the bootstrap environment token at startup and are not exposed in subsequent panel responses. The initial TELEGRAM_BOT_TOKEN must still be syntactically valid for bootstrap configuration; keep it configured. Replacement takes effect after a server restart, as stated in the panel. Optional controls now start and stop the configured Agent Host through Docker Engine API v1.47. They require an explicit Unix socket path and fixed container name/ID, inspect the agent label before acting, use the immutable Docker ID for mutations, and record that reference before the operation. The panel is authenticated, validates POST origins, and asks for confirmation before stopping. Stop requests allow ten seconds for graceful task interruption; the existing Agent Host shutdown and startup recovery record interrupted work. These controls never remove containers or volumes. Docker access remains disabled by default; an optional compose.docker.yaml mounts the socket only in the server. Dynamically registered agents now have server APIs for provisioning and Docker resource removal; automatic provisioning and panel integration remain pending. Container start/stop operations now persist their latest action, outcome, and timestamp in SQLite before Docker mutation. The authenticated `/api/status` endpoint exposes this record. Pending operations become interrupted on server restart; this records uncertainty and does not automatically retry Docker actions. Docker inspection and Agent Host health remain the sources of current runtime status. When Docker controls are enabled, the authenticated `/api/status` endpoint also inspects the configured container on each request and reports `container` as `running`, `stopped`, `missing` (Docker returned 404), or `unavailable` (Docker failure, invalid inspection data, or a mismatched agent label). This field is omitted when Docker controls are disabled. Inspection does not recreate resources or retry mutations; the panel continues to show missing containers as unavailable. Dynamic provisioning remains pending. Before submitting a task, the bot now checks Agent Host health and tells the owner when the agent is stopped or not ready, without submitting the message; Telegram `/status` reports the same ready, busy, or unavailable state. Compose sets the memory-plus-swap limit equal to the memory limit, so containers get no additional swap.

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

Agent creation now has a server-side registration workflow and an authenticated same-origin `POST /api/agents` endpoint (enabled with provisioning). Form fields are `name`, optional `instructions`, `ownerId`, and the BotFather `token`; the server generates the resource-safe agent ID. It rejects non-allowlisted owners before Telegram access, verifies the bot through bounded `getMe`, writes a private credential file, and atomically records the linked bot, agent metadata, credential reference, and pending provisioning state before Docker is called. Duplicate bot identities, including legacy chat bindings, roll back registration and remove the candidate credential. Concurrent requests for the same bot register only one agent. Provisioning failures retain the registered agent, credential, resource references, and explicit setup state; the response exposes only the new ID and provisioning state. The panel now exposes this workflow through a creation form and a persistent setup-result page; registered bot polling and initial task routing are now implemented below.

With provisioning configured, the panel offers “Create agent” and a single-column form for name, optional instructions, authorized owner Telegram ID, and BotFather token. Server validation preserves non-sensitive fields and clears the token on errors. Successful registration redirects to a setup page that reads persisted metadata on each refresh, distinguishing an available container from incomplete provisioning without resubmitting creation. The page reports setup, bot polling, and owner activation separately; tasks require completed setup and activation. The form is hidden when provisioning is disabled. Chromium checks covered the creation/error flow, keyboard order, and overflow at desktop, 375px, and 320px widths; automated tests cover access control, origin checks, escaping, token non-disclosure, and incomplete setup.

The saved setup page now links to per-agent name/instruction editing at `/agents/:id/settings`. The form reuses the existing validation, escaping, limits, and save confirmation, and returns to that agent’s setup page. Server callbacks resolve the requested registry ID, enforce the owner allowlist, and update only that agent in SQLite. The bootstrap agent’s existing edit route remains available. Automated coverage verifies access/origin checks, validation, escaping, missing agents, and isolation between edits to two registered agents; Chromium checks cover editing and returning to the updated setup page. Per-agent token replacement, container start/stop controls, and explicit task interruption observation are now implemented, completing the combined editing/control task.

Each registered agent’s setup page now links to `/agents/:id/token`. The form identifies the selected agent, accepts only a replacement token for its already linked bot, and reuses bounded Telegram verification and private-file persistence. Server callbacks enforce the owner allowlist; routes require administrator authentication and same-origin submission. Errors never echo the submitted token and link back to the same agent. Successful saves redirect to a confirmation that states the restart requirement; neither the old nor new credential is rendered. Automated coverage uses real SQLite and private files to verify wrong-bot rejection and credential isolation between agents; Chromium checks cover rejection, retry, and confirmation. Registered bots now poll from the server; token replacements still require a server restart.

Provisioned agents now have start/stop controls on their setup page. Stop opens a confirmation naming the selected agent and explaining possible task interruption and data retention. Form submissions reuse the authorized, persisted per-agent Docker action workflow and redirect back to the same agent. On refresh the server inspects the saved container ID, checks the correct authenticated Host endpoint, and displays the last persisted operation independently of provisioning metadata. A stopped container no longer appears available merely because provisioning previously succeeded. Missing agents and unconfirmed/cross-origin requests are rejected; errors return to the selected agent without exposing Docker details. The panel reports the Docker operation separately from the persisted task observation. When a task was captured before stopping, refresh checks that exact task’s record once the Host is reachable and retains a confirmed interrupted, completed, or failed result across subsequent restarts.

As groundwork for explicit task interruption reporting, the authenticated Agent Host API now exposes `GET /tasks/current`, returning only the persisted active task ID and accepted/running state, or `task: null` when no task is active. It never returns prompts or output. The query rejects multiple active records instead of arbitrarily choosing one; unavailable task execution/storage returns 503. Restart recovery continues to mark unfinished tasks interrupted, so those records no longer appear active. A bounded, authenticated server client distinguishes an observed idle Host from unavailable or malformed responses. Capturing this reference before stopping, persisting it on the server, and confirming its final state in the panel are now implemented for dynamically registered and pre-configured agent controls.

Dynamically registered agent stop actions now capture the authenticated Host current-task observation after acquiring the persisted operation guard and before Docker access. SQLite migration 5 saves only availability, task ID/state when active, and observation time; idle and unavailable remain distinct. Credential/read failures record unavailable and still allow stopping. Snapshots survive restart and later starts, and Docker failures do not erase them. These are pre-stop observations only, not proof that a task was interrupted or completed. Final task-state confirmation and panel presentation are now implemented as described below.

The panel now presents task observations for both dynamic and pre-configured agent controls separately from Docker operation results. The authenticated metadata-only `GET /tasks/:id/status` endpoint reports the exact captured task’s persisted state, with a bounded server query. An interrupted, completed, or failed record confirms the outcome; an offline Host, missing task, malformed response, or accepted/running record leaves the result unconfirmed. Refresh after starting the Host can confirm shutdown/recovery results. Migration 6 persists final outcomes and unique observation identities; late refreshes cannot overwrite a newer stop, and confirmed outcomes remain visible when the Host later goes offline. Starting preserves the previous stop observation; a new stop invalidates it before observation. The panel also distinguishes an observed idle Host from an unavailable pre-stop observation. Automated tests cover API authentication and metadata isolation, shutdown/recovery, durable outcomes, stale-response races, and both panel surfaces; Chromium checks cover six displayed states and keyboard refresh at 320px, 375px, and desktop widths. This completes the combined editing/control task.

Provisioning now observes server shutdown cooperatively. SIGINT/SIGTERM cancels outstanding setup between steps and during readiness backoff; an in-flight Docker mutation is allowed to settle and its resource references are saved before cancellation is recorded. No new creation/start steps are scheduled after observing cancellation. SQLite migration 7 adds a durable `cancelled` provisioning state and preserves existing references. Cancelled agents cannot use the ready-only container controls; explicit provisioning retry or resource cleanup remains available through the existing protected APIs. A cancellation during startup may retain a running container; it is never silently deleted or treated as ready. The setup page now distinguishes pending, in-progress, completed, failed, interrupted, cancelled, and externally managed provisioning. This is setup cancellation on server shutdown, separate from Telegram task `/stop`; bot setup/owner-verification states and dynamic task-routing guards are now implemented below. Abrupt process termination still uses the existing interrupted-on-restart recovery.

The creation panel now returns to the saved agent’s setup page while provisioning continues in the server, so cancellation is available during setup. Only a live provisioning attempt offers “Cancel setup”; the same-origin authenticated form requires the selected agent ID and preserves all resources. `POST /api/agents/:id/provision/cancel` uses the same checks and returns 202 for a cancellation request, not a completed cancellation. The server checks the owner allowlist, persists the request timestamp through SQLite migration 8 before signalling that agent’s attempt, and shows “Cancellation requested” until its current Docker operation settles and the coordinator records cancelled setup. Requests cannot cancel another agent, resource cleanup, or an already completed attempt; stale forms return a recoverable conflict. Completed/failed/cancelled attempts release their live guard, background errors are handled without exposing provider details, and server shutdown still cancels outstanding attempts. Requests survive restart as metadata, while unfinished provisioning is marked interrupted; explicit retry/cleanup clears the old request. Bot setup/owner-verification states and dynamic task-routing guards are now implemented below.

A registry-backed admission check now guards the pre-configured bot’s chat activation and task submission. It verifies the current bot/credential link and allowlisted owner, requires the persisted chat binding to match that bot, agent, owner, and receiving chat, and blocks dynamic-style agents unless provisioning is ready with saved resource/Host credential references. Only the explicitly configured bootstrap agent may use externally managed provisioning. Pending container operations, cancellation requests, incomplete setup, and unavailable storage block task submission even if Host health reports ready; the check is repeated after the asynchronous health query. Owner activation can be saved before provisioning completes, but the bot then explains that tasks remain unavailable. Registry reads invalidate stale activation when the saved owner or bot identity changes. The status API and both panel surfaces now distinguish linked/unlinked/unavailable bot setup and pending/verified/not-allowlisted/unavailable owner verification, without exposing credentials or chat IDs. These fields describe saved setup, not polling connectivity. Registered bot polling and its setup-failure integration are now implemented below, alongside durable creation-intent tracking for failed setup.

With provisioning enabled, the server now starts registered agent bots after successful provisioning and considers saved agents on startup. Only ready, linked agents with allowlisted owners and readable private bot/Host credentials enter polling; the bootstrap bot uses its own independent lifecycle. Each connection performs one bounded authenticated Telegram identity check before polling, requires the saved bot ID and current owner assignment, and uses its own persistent chat binding, private Host endpoint/token, and live name/instruction settings. The existing admission guard blocks incomplete setup and checks the bound bot/owner/chat before tasks. Per-agent setup pages distinguish not-started, connecting, polling-started, blocked, failed (including missing credentials, wrong identity, or a rejected token), and stopped states independently of container readiness. Shutdown cancels initialization and stops each registered polling loop before closing its binding. A connection failure remains local to that agent. Tests exercise the real grammY polling loops with simulated Telegram and Host responses, including two-agent routing, owner activation, live settings, revoked tokens, identity mismatch, incomplete setup, missing credentials, and shutdown. Polling-started describes the active loop, not guaranteed continuous Telegram reachability; bounded transient-failure retries, restart reconciliation, and live Telegram/Docker end-to-end acceptance remain separate pending work. Durable creation intents and real-Docker response-loss coverage below complete the remaining setup-state acceptance.

SQLite migration 9 now persists each new resource creation intention before its Docker POST, including the fixed resource name, agent ID, resource kind, operation UUID, and timestamp. Docker resources carry that same operation UUID label. Successful inspection verifies the creation operation before saving the immutable reference; only then is the intention cleared. A lost response, unavailable inspection, failed metadata write, or restart leaves the intention available for review and keeps setup non-ready. The authenticated resource inventory adds `uncertain` intentions and accounts for an observed resource only when agent, kind, fixed name, and operation label match; it never adopts or starts a resource from an intention, or interprets its absence from a listing as proof that creation failed. Explicit resource cleanup resolves only operations whose matching resources were observed and successfully removed, and preserves volume intentions unless data deletion was selected. A 404 retains uncertainty because a delayed creation could still complete. Setup cannot become ready while any creation intention remains unresolved. Multiple uncertain attempts for the same name remain recorded. Unit tests cover lost replies for all three volumes, the network, and container, persistence failures, restart, operation mismatch, and cleanup. An opt-in real-Docker test drops the successful container-create reply, reopens SQLite, verifies the stopped container is still accounted for, and checks retained-volume and explicit-data cleanup. Run it with `NIMBOT_TEST_DOCKER_IMAGE=sha256:<local-image-id> pnpm test apps/server/src/provisioning-intents.integration.test.ts`. This completes the Phase 2 setup-state and incomplete-setup tracking task; the remaining Phase 2 acceptance tasks stay separate.

The Phase 2 owner-activation acceptance is now covered by dedicated real-handler/SQLite tests. `/start` accepts only the current allowlisted owner in a private chat after verifying the saved bot/owner assignment. The binding is persisted before activation callbacks or the success reply. Two agents belonging to the same owner keep independent bindings even though Telegram gives both bots the same private chat ID; repeated `/start` and reopening the registry, binding stores, and bot instances preserve that isolation. Non-owners, non-allowlisted users, groups/supergroups, and updates without a sender produce neither replies nor binding writes. A changed owner must activate again, and a failed activation write produces a plain error without a success acknowledgement, while other agents still activate and the failed agent can retry. Telegram updates and replies are simulated; live end-to-end acceptance remains separate. This completes the owner/private-chat activation task.

The Phase 2 per-bot polling isolation task is now complete across the bootstrap and registered bots. Bootstrap credential loading has moved out of global state initialization into its own connection lifecycle: an unreadable saved token, Telegram authorization failure, or identity mismatch disconnects only that bot and never falls back to the environment token. Its first identity check is bounded and cancellable, and repeated starts share one polling lifetime. Shutdown cancels pending verification and webhook setup without opening another connection. Dedicated composition tests run real grammY loops with simulated Telegram replies and prove a registered bot still handles its owner’s `/start` while the bootstrap fails during credential loading, identity verification, or polling, or is stopped during initialization. The composition tests also revoke a registered token while the bootstrap continues owner activation, and cover initial bootstrap linking from the environment. Existing registered-bot tests cover isolation between registered agents. Shared installation configuration/storage errors remain startup errors, and Phase 4 transient retry/recovery work and live end-to-end acceptance remain separate.

### Tasks

- [x] The server stores agents, owners, instructions, containers, bot identities, credential references, chat bindings, and provisioning state in SQLite, with migrations.
- [x] The server can create, start, stop, and delete agent containers and volumes through the Docker Engine API. Container specifications come from a fixed template in server code: a pinned Agent Host image, named volumes only, no host bind mounts, no privileged mode, and no settings taken from panel input or agent output beyond the agent ID and resource limits.
- [x] Containers, volumes, and networks created by the server carry a Nimbot agent ID label, so the server can reconcile them with the registry and detect untracked or missing resources.
- [x] Agent containers run as non-root with all Linux capabilities dropped, `no-new-privileges`, CPU, memory (with no additional swap), and process limits, and without the Docker socket or server credentials.
- [x] Each Agent Host has its own internal API token and its own Docker network shared only with the Nimbot Server, so one agent cannot reach another agent's API. Agent Host ports are never published on the host.
- [x] The panel creates agents with a name, optional instructions, owner Telegram ID, and a bot token from BotFather; the server validates and links the bot before provisioning.
- [x] The panel edits agent names and instructions, replaces tokens for the same bot, and starts/stops containers with explicit task interruption status.
- [x] Bot setup, owner verification, cancellation, and provisioning failures have explicit states; incomplete setup does not route tasks or leave an untracked container.
- [x] Starting an agent bot verifies its owner and activates its private-chat binding.
- [x] Each agent bot has its own long-polling connection, managed by the same server; one bot’s failure does not stop the others.
- [x] The panel lists agent and bot states and provides links to the respective agent chats.
- [x] Panel deletion requires confirmation, retains persistent volumes by default, and deletes data only when explicitly selected. It stops polling the bot and removes its local binding and credential. The confirmation explains that Telegram bot identity deletion is separate.
- [x] Messages go only to the agent bound to the receiving bot, with a clear reply when that agent is stopped or not ready.
- [x] A bot already bound to another agent, an invalid token, a non-allowlisted owner, and unauthenticated setup requests are rejected.

### Telegram Commands

| Command | Description |
|---|---|
| `/start`, `/help` | Activate the owner's chat and display this agent's help |
| `/status` | Display this agent's status |
| `/stop` | Cancel this agent's active task |
| Text message | Send a task to this bot's bound agent |

Agent creation, configuration, container start/stop, token linking, and deletion are panel actions. Telegram has no `/new`, `/agents`, `/delete`, or `/use` administration workflow.

### Acceptance Criteria

- Two agents run independently, each with a distinct Telegram bot, private chat, container, and persistent volume.
- Interleaved messages to agent bots A and B produce replies in the matching chats without switching an active agent.
- An allowlisted user cannot access an agent owned by another user.
- The panel can create, configure, start, stop, and delete agents; its API rejects unauthenticated and forged state-changing requests.
- Deleting an agent preserves its volume unless data deletion is explicitly confirmed.
- One agent cannot read another agent's workspace through its workspace or supported tools.
- Agent Hosts are reachable only from the Nimbot Server.

---

## 9. Phase 3 — Tasks, Progress, and Browser

**Goal:** Agents handle long-running work that the user can follow and stop.

### Tasks

- [x] Each agent conversation, identified by bot ID and private chat ID, has a persistent FIFO task queue and runs one turn at a time.
- [x] Incoming messages and task state changes are saved before execution.
- [x] Progress updates are sent through the originating agent bot to its owner’s bound chat while a task runs.
- [x] `/stop` in an agent bot cancels only that agent’s running task, and the agent accepts a new task afterwards.
- [x] Tasks have a timeout, and a failed task does not block the tasks behind it.
- [x] Browser tasks work through Playwright, using the approach chosen in Phase 0.
- [x] Approval requests for sensitive actions are sent through the originating agent bot and can be accepted or denied only by its authorized owner; callbacks are bound to that agent and task.

### Acceptance Criteria

- A long-running task shows progress and can be cancelled.
- Several messages sent in a row are processed in order.
- An agent can open a public website and summarize it.

---

## 10. Phase 4 — Recovery and Hardening

**Goal:** Make the self-hosted MVP reliable enough for practical use.

### Tasks

- [x] After a server restart, agents, owners, bot credentials and bindings, polling connections, and container states are restored, and missing or stopped containers are detected.
- [x] After an Agent Host restart, the conversation continues, and in-flight tasks are resumed or marked interrupted and reported to the user.
- [x] Duplicate Telegram updates do not create duplicate tasks; deduplication uses bot ID and update ID, since update IDs are not shared across bots.
- [x] Telegram, Docker, and OpenCode failures are retried a bounded number of times and then reported, without leaving the system stuck. A revoked or invalid agent bot token is shown in the panel and does not stop other agents.
- [x] The server and Agent Hosts expose health checks and write structured logs with agent and task IDs, with secrets redacted.
- [x] Automated checks confirm that agent containers keep their dropped capabilities, resource limits, and per-agent networks after recreation and server restart, and that internal APIs are not exposed outside their Docker networks.
- [x] Automated tests cover panel authentication, session expiry, CSRF protection, bot linking, owner authorization, message routing, task state transitions, restart recovery, cancellation, and multi-agent isolation.

Server restart recovery: agents, owners, bot identities, credential references, chat bindings, and provisioning state live in SQLite and private files. On startup the server marks unfinished tasks and provisioning attempts interrupted and restarts polling for every saved agent without a new `/start`. Container state is not cached: the status API and setup pages inspect Docker on each refresh and report `stopped`, `missing`, or `unavailable`, and the bot tells the owner when a stopped Host cannot take tasks. A restart test closes the registry, task store, and bot manager, reopens them from disk, and verifies both bots poll again, keep their owners and bindings, accept tasks in their own chats, and answer plainly when a Host is down. Live Docker/Telegram restart acceptance stays with the section 12 test.

Agent Host restart recovery: the Agent Host keeps one OpenCode session ID in its task-state volume (`engine-session.json`, written atomically with mode 600) and loads that session for each later task, so the conversation continues across tasks and container recreation. History replayed by `session/load` is discarded rather than sent to the user. If the saved session cannot be loaded (missing, unsupported, or corrupt), the task runs in a new session and the ID is replaced; losing continuity never fails a task. A task that was running when the Host stopped is recorded as interrupted on startup, never resumed automatically, because partial tool effects cannot be replayed safely. The server tolerates up to fifteen consecutive failed event polls (one second apart) while observing a task, keeping its event cursor, so it receives the interruption the restarted Host recorded and tells the owner “The task was interrupted by an Agent Host restart.” Task submission is still never retried. Tests use a fake `opencode acp` process for session creation, loading, replay suppression, and fallback, and simulate a Host outage during polling. Live validation with a real OpenCode model remains with the section 12 test.

Failure handling progress (task partly done): the initial Telegram identity check for the pre-configured and registered bots is retried twice more (0.5 s, then 1.5 s) for network errors, 5xx, and 429 responses; cancellation and definitive 4xx rejections such as a revoked token (401) are never retried. grammY's own polling loop already backs off on transient `getUpdates` failures. Failures stay local to one bot. Registered bot setup pages already show `invalid_token`; the pre-configured agent's panel page now shows “Telegram rejected the bot token” or “Could not reach Telegram after several attempts” (`telegramFailure` in the status API). The Agent Host event polling retry is described above. Task submissions are never retried, because a repeat could run a task twice; an OpenCode failure fails that task with a plain-language reply and does not block the queue. The remaining parts are described next, which completes this task.

Docker and OpenCode failure handling: Docker Engine API reads (inspection and listings) are retried twice more (0.2 s, then 0.6 s) after a transport failure or a 5xx answer, then the failure is returned and the panel shows `unavailable`; retries are logged as `docker.read_retry` and a final transport failure as `docker.request_failed` (method and attempt count only, never paths or bodies). Creates, starts, stops, and deletes are never repeated, because their outcome may be unknown; those stay tracked as persisted, uncertain operations. In the Agent Host, a failed OpenCode start (process crash or failed `initialize`/session setup) is repeated twice more (0.5 s, then 1.5 s) while nothing has been sent to the model; a stop request ends the attempts. Once the prompt has been sent, an engine failure fails that task with a plain-language reply, since repeating could act twice, and the queue continues with the next task. Tests cover each bound with injected transports and a fake `opencode` process, and the opt-in real-Docker suite still passes.

Health and logging: the server and each Agent Host have container health checks in `compose.yaml` (the Host's authenticated `/health` also serves the server's readiness checks). Both apps write one JSON object per line to stdout (info) or stderr (warn/error) with `time`, `level`, `event`, and context fields such as `agentId` and `taskId`. The server logs bot connection results, provisioning failures, and task start/finish with agent and task IDs; the Agent Host logs task accepted/finished with the task ID. Prompts, task output, and error details are never logged. A redaction pass removes Telegram tokens, bearer credentials, 64-hex Host tokens, scrypt password hashes (`scrypt:salt:hash`), and any field named like token, password, secret, authorization, credential, or cookie. `NIMBOT_LOG=silent` turns logs off (used by the test suite). The small logger is duplicated in `apps/server/src/logger.ts` and `apps/agent-host/src/logger.ts` rather than adding a shared package for 60 lines; keep them in step. Docker action failures are not logged yet, which is part of the still-open failure-handling task.

Hardening checks: three opt-in real-Docker tests cover this task. The lifecycle test verifies the template and kernel-enforced state before and after container recreation; the isolation test verifies per-agent networks, no published ports, and that neither Host can reach the other; the restart test (`apps/server/src/restart-hardening.integration.test.ts`) records user, dropped capabilities, no-new-privileges, CPU/memory/swap/process limits, mounts, single network, and the absence of published ports, then repeats the comparison after the server stand-in container is stopped and started and after the Agent Host container itself is stopped and started, requiring identical results and a working authenticated server-to-Host call each time. Run all with `NIMBOT_TEST_DOCKER_IMAGE=sha256:<local-image-id> pnpm test integration`. All five passed against Docker 29.9 with the current local image, and no labeled resources were left behind. The tests skip without the variable, so default `pnpm test` stays Docker-free.

Test coverage map for the critical workflows (all run with plain `pnpm test`, no Docker or network): panel authentication, session expiry, CSRF/origin checks, and login rate limiting in `panel.test.ts`; bot linking in `agent-registration.test.ts`, `bot-token-update.test.ts`, and `registry` tests; owner authorization in `agent-access.test.ts`, `agent-activation.test.ts`, `chat-binding.test.ts`, and `bot.test.ts`; message routing and multi-agent isolation in `registered-bots.test.ts` and `bot-connections.test.ts`; task state transitions, persistence, and duplicate updates in `task-queue.test.ts` and the Agent Host `tasks.test.ts`; restart recovery in the restart tests above; cancellation in `task-queue.test.ts`, `host-tasks.test.ts`, and `tasks.test.ts`. `tests/task-flow.integration.test.ts` joins the pieces: the server queue and client drive a real Agent Host API and task runner (scripted engine) and verify ordered processing, cancellation of only the running task, and a Host restart that is reported as interrupted while the next queued task still runs. Cross-container isolation stays in the opt-in Docker tests.

**Security limitation:** The MVP is intended for trusted self-hosted deployments. Docker containers alone do not provide sufficient isolation for hostile multi-tenant workloads.

Managing containers requires giving the Nimbot Server access to the Docker Engine API. That access is equivalent to root on the host, so a compromise of the server or its panel is a compromise of the host. The fixed container template limits what the server asks Docker to do; it does not limit what an attacker controlling the server could do. Running Nimbot under rootless Docker reduces this exposure and is recommended where practical.

Agent containers have unrestricted outbound network access in the MVP, including to private addresses reachable from the host's network. Disk usage of agent volumes is not limited. Operators who need either restriction must apply it on the host.

### Acceptance Criteria

- Restarts do not lose committed conversations or files.
- Unauthorized Telegram users cannot access agents.
- Agent Hosts do not receive host-level credentials.
- Failed tasks do not leave the system permanently blocked.

---

## 11. Phase 5 — Packaging and Release

**Goal:** Make Nimbot installable by self-hosted users.

### Tasks

- [x] Dockerfiles for both apps, `compose.yaml`, and `.env.example` exist, with restart policies and health checks.
- [ ] A fresh install on a clean Linux server works by following the documentation alone.
- [x] The documentation covers installation, panel administrator setup, HTTPS access, per-agent BotFather token linking and chat activation, token replacement, AI provider authentication, environment variables, and commands.
- [x] The documentation covers backup and restore, troubleshooting, and security limitations.
- [x] The repo has an Apache 2.0 `LICENSE`, `CONTRIBUTING.md`, and `.gitignore`.
- [x] CI runs linting, type checking, and tests.
- [ ] The end-to-end test in section 12 passes, versioned Docker images are built, and `v0.1.0` is tagged with release notes.

Packaging status: `infrastructure/docker/server.Dockerfile` and `agent-host.Dockerfile` build both images (verified with `docker compose build`), and `compose.yaml` sets `restart: unless-stopped`, health checks, non-root users, dropped capabilities, and resource limits for both services; `.env.example` lists every setting including `TASK_TIMEOUT_SECONDS`. `LICENSE` (Apache 2.0), `CONTRIBUTING.md`, and `.gitignore` are present. `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile`, lint, typecheck, build, and tests on pushes to `main` and pull requests; the root `packageManager` field pins pnpm for it. The same commands pass locally, but the workflow has not run on GitHub yet. `docs/INSTALL.md` covers requirements, build, administrator password hash (generated with `docker run -it nimbot-server node apps/server/dist/password.js`, checked in a real pseudo-terminal), configuration, HTTPS through a reverse proxy, per-agent BotFather linking and chat activation, token replacement, per-agent AI provider authentication with `opencode auth login` inside each agent's container, optional panel provisioning, environment variables, Telegram commands, and everyday operations. `docs/OPERATIONS.md` covers what data lives where, backup and restore with volume archives (the commands were exercised against throwaway volumes, including ownership preservation), troubleshooting by symptom, and the security limitations. It states a known limitation: after restoring on a different host, panel-created agents keep their volumes and registry entries, but the panel has no action to recreate their containers (only the provisioning and cleanup APIs exist, without panel buttons), so restoring on the same host is recommended. The clean-server walkthrough and the release steps remain open.

### Acceptance Criteria

- A user can install Nimbot, sign in to the panel and link distinct agent bots, authenticate the AI provider, and operate agents using only the documentation.

---

## 12. End-to-End MVP Acceptance Test

The following scenario must work before releasing `v0.1.0`.

### Scenario: Two Persistent Agents

**Step 1 — Installation**

Install Nimbot on a Linux server using Docker Compose.

**Expected:** The Nimbot Server starts successfully and serves the panel. Unauthenticated access is rejected; the configured administrator can sign in.

**Step 2 — Create Agent A**

Create a distinct bot in BotFather. In the panel, create an agent named `developer`, enter its instructions, owner Telegram ID, and bot token, and submit.

**Expected:** Nimbot binds a distinct Telegram bot to the agent, creates an Agent Host with a dedicated persistent workspace, and returns the bot link. Open that bot and press Start to activate the owner’s private chat.

**Step 3 — Execute a Task**

In the `developer` bot’s private chat, send:

`Create a Python script that generates a CSV file containing 100 random numbers.`

**Expected:** The agent creates the file and reports completion.

**Step 4 — Verify Persistence**

Restart the Agent Host.

In the same `developer` bot’s chat, send:

`Read the CSV file you created earlier and calculate its average.`

**Expected:** The file still exists and the agent can access it.

**Step 5 — Create Agent B**

Return to the panel, create an agent named `researcher`, link another BotFather-created bot, and press Start in its chat.

**Expected:** A separate Telegram bot, Agent Host, and workspace are created. Send interleaved tasks to both bots; each replies only in its own chat, without `/use`.

**Step 6 — Verify Isolation**

In the `researcher` bot’s chat, ask Agent B to list its workspace.

**Expected:** Agent B cannot access Agent A's files through its assigned workspace or supported tools.

**Step 7 — Browser Task**

In the `researcher` bot’s chat, ask Agent B to open a public website and summarize its contents.

**Expected:** The browser launches and the agent returns a summary.

**Step 8 — Restart Nimbot**

Restart the Nimbot Server and both Agent Hosts.

**Expected:** Both agent bots reconnect with their original owners and chat bindings; agents, conversations, workspaces, and configurations remain available. Neither agent requires selecting it again.

**Step 9 — Cancel a Task**

Start a long-running task in the `developer` bot and send `/stop` in that chat while the `researcher` bot is also working.

**Expected:** Only the developer task is cancelled or safely terminated; its agent can accept a new task, and the researcher task is unaffected.

**Step 10 — Authorization**

Attempt to access panel pages and administration API endpoints without a session, and submit a forged state-changing request. Send commands to both agent bots from an unauthorized Telegram account. Also attempt to use an agent from an allowlisted account that does not own it.

**Expected:** Access is rejected without exposing agent data.

---

## 13. MVP Definition of Done

Nimbot `v0.1.0` is complete when all of the following are true:

- [ ] Installation works through Docker Compose.
- [ ] Telegram integration works.
- [ ] Telegram authorization works.
- [ ] The authenticated panel can create, configure, start, stop, and delete agents.
- [x] Panel credentials and sessions are protected, and unauthorized API requests are rejected.
- [x] Bot tokens can be linked and replaced securely through the panel.
- [x] Each agent has a distinct Telegram bot and owner-bound private chat.
- [ ] Tasks, progress, approvals, and results remain in the correct agent chat.
- [x] There is no shared active-agent selection or `/use` workflow.
- [x] Each agent runs in its own Docker container.
- [x] Each agent has persistent storage.
- [ ] OpenCode works through ACP.
- [ ] Agents can execute terminal commands.
- [ ] Agents can read and write files.
- [ ] Agents can use a browser.
- [ ] Conversations persist across restarts.
- [x] Tasks can be cancelled.
- [x] Interrupted tasks are handled safely.
- [x] Duplicate incoming messages do not execute tasks twice.
- [x] Agent workspaces are isolated under the documented threat model.
- [x] Automated tests cover critical workflows.
- [x] Installation and troubleshooting documentation are complete.
- [x] The project is released under Apache License 2.0.

Definition of Done status: the checked items are backed by automated tests (panel authentication and CSRF, token linking and replacement, owner-bound per-bot bindings, queue cancellation and interruption, update deduplication, no `/use` command) or by the opt-in real-Docker tests (one container, named volumes, and private network per agent; isolation between agents). The unchecked items need live validation that has not been done against real Telegram bots, a real AI provider, and a clean server: installation through Docker Compose, Telegram integration and authorization, task and approval delivery, OpenCode with terminal, files, and browser through the full path, and conversation persistence across restarts. They close with the section 12 scenario, which needs the maintainer's BotFather tokens, Telegram user ID, and AI provider credentials.

---

## 14. Post-MVP Backlog

The following features are intentionally deferred.

### AI Engines

- Codex native integration
- Claude Code integration
- Additional ACP providers
- Per-agent engine selection
- Engine switching

### Messaging

- WhatsApp
- Slack
- Discord
- Shared agents and multiple owners
- Group, channel, and topic-based agent conversations
- File and media attachments
- Voice messages
- Management bots and Telegram Managed Bots provisioning

### Agent Capabilities

- Agent-to-agent communication
- Agent delegation
- Shared tools
- Advanced memory retrieval
- Scheduled tasks
- Recurring automations
- Advanced approval workflows
- MCP server integrations

### User Experience

- Advanced dashboards and analytics
- Web chat and richer agent configuration tools
- Agent templates
- Browser-based terminal
- Workspace file explorer
- Conversation search

### Operations

- Multi-server deployments
- Distributed task scheduling
- Advanced monitoring
- Automated backups
- Container image management
- Alternative container runtimes
- Stronger execution isolation

---

## 15. Engineering Principles

All MVP development should follow these principles.

**1. Self-hosted first.** Nimbot must operate independently on the user's infrastructure.

**2. Persistent by default.** Agent conversations, sessions, and files must survive restarts.

**3. One agent, one bot, one execution environment.** Each agent has a distinct Telegram bot and private conversation. Agents must not share workspaces, execution processes, or a global active-agent selector.

**4. Engine independence.** Agent management must not be tightly coupled to OpenCode.

**5. Interface separation.** The web panel handles administration and Telegram handles agent conversations. Telegram and panel-specific logic must remain outside the core agent runtime.

**6. Durable execution.** Messages and tasks must be persisted before execution whenever possible.

**7. Explicit failure handling.** Errors, cancellations, and interrupted tasks must have defined behavior.

**8. Minimal dependencies.** Prefer SQLite and Docker over unnecessary external services.

**9. Secure defaults.** Do not expose internal APIs, host credentials, or Docker access to agent workloads.

**10. Incremental delivery.** Each implementation phase must produce a testable, working component.

---

**Nimbot — Your AI agents, always in the cloud.**
