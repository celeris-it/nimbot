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

The panel uses a locally configured scrypt password hash, opaque server-side sessions with an eight-hour expiry, HttpOnly/SameSite cookies (Secure for HTTPS), same-origin validation on all POST requests, and a global limit of five login attempts per fifteen minutes. Sessions and rate-limit state are in memory for this phase; restarting the server signs administrators out. The panel stays available with a disconnected status if Telegram startup fails. Authentication, logout, expiry, CSRF, rate limits, and protected API access have automated coverage; login/logout and responsive layouts were checked in Chromium with a simulated bot status. Live Telegram validation previously confirmed that an allowlisted user receives the welcome and setup notices. Owner checks apply in addition to the allowlist, so another allowlisted user cannot activate or use this agent. `/help` and `/status` do not activate the chat. Activation is now persisted in a server-side SQLite database, keyed by agent ID and checked against the verified Telegram bot ID and configured owner. The owner must activate again if that identity no longer matches. `/start` commits the binding before confirming activation; failed writes do not activate a new chat. The server restores panel activation after Telegram verifies its bot identity. A named server-state volume retains the database across container recreation. This small identity store uses Node’s built-in SQLite API (Node 22.13 or newer), without adding a database dependency; task storage continues to use Drizzle. Panel sessions remain in memory. Compose defines both applications, named persistent workspace and engine-state volumes, non-root execution, resource limits, and an unpublished Agent Host API. The authenticated `/health` endpoint checks workspace access and reports busy/idle engine state. The server image and its panel health check are included. Docker validation confirmed non-root execution, API rejection without authentication, successful server-to-host health requests, and workspace file retention after container recreation. This does not validate task execution through the API. The internal API now accepts one task at a time with `POST /tasks` and returns persisted state and output through `GET /tasks/:id`. Prompts and initial state are committed to SQLite through Drizzle before execution, and task state has its own persistent volume. Concurrent submissions receive 409. Execution has a two-minute timeout and a 64,000-character output limit; leftover accepted/running records become interrupted on startup. Each API task currently uses a fresh OpenCode session, and permission requests are denied by default. Docker validation with a free OpenCode model confirmed that a server-container request completes a prompt and that its result remains queryable after Agent Host recreation. The server now submits activated owner text to this API and polls persisted state events until completion, returning plain-text results through the originating bot and chat. Replies are split at 4096 UTF-16 code units without breaking surrogate pairs. Busy, failed, interrupted, unavailable, and timeout states receive plain-language responses; ambiguous submissions are never retried automatically. Polling is bounded to 150 seconds, with five-second request timeouts. Basic grammY polling processes updates sequentially, so commands wait while a task runs; a durable queue, responsive cancellation, live engine-output events, API session continuity, and approvals remain pending. Chat activation now survives server restarts; the state event API is implemented. New automated coverage was added. Lint and independent smoke checks passed. A strict TypeScript check of both apps through the compiler API also passed and uncovered two test typing errors, now corrected. The standard workspace type-check command and Vitest suite remain blocked because dependency installation rejects five lockfile entries under the configured minimum release age policy. Live Telegram-to-OpenCode validation remains pending. State transitions and their events are committed atomically through Drizzle/libSQL batch transactions. The authenticated `GET /tasks/:id/events?after=<sequence>` endpoint returns ordered events with a monotonically increasing sequence and final output/stop reason on completion. The server advances its cursor after each event. An additive migration backfills the latest state of legacy tasks; restart recovery records interruption once. Events currently describe state transitions, not live model output. Independent checks passed against real SQLite, Hono, and the server client for completion, cursors, authentication, restart recovery, and legacy migration.

### Acceptance Criteria

- An authorized owner starts the agent bot, sends a programming task in its private chat, and receives the result there.
- The administrator can sign in to the panel, inspect the agent, and open its Telegram chat. Unauthenticated requests cannot access the panel or administration API.
- An unauthorized user is rejected.
- Files the agent created are still there after the container restarts.

---

## 8. Phase 2 — Multiple Agents

**Goal:** Create and manage agents from the authenticated panel, each with its own Telegram bot, private conversation, container, and persistent volume.

### Tasks

- [ ] The server stores agents, owners, instructions, containers, bot identities, credential references, chat bindings, and provisioning state in SQLite, with migrations.
- [ ] The server can create, start, stop, and delete agent containers and volumes through the Docker Engine API.
- [ ] Agent containers run as non-root with CPU, memory, and process limits, and without the Docker socket or server credentials.
- [ ] The panel creates agents with a name, optional instructions, owner Telegram ID, and a bot token from BotFather; the server validates and links the bot before provisioning.
- [ ] The panel edits agent names and instructions, replaces tokens for the same bot, and starts/stops containers with explicit task interruption status.
- [ ] Bot setup, owner verification, cancellation, and provisioning failures have explicit states; incomplete setup does not route tasks or leave an untracked container.
- [ ] Starting an agent bot verifies its owner and activates its private-chat binding.
- [ ] Each agent bot has its own long-polling connection, managed by the same server; one bot’s failure does not stop the others.
- [ ] The panel lists agent and bot states and provides links to the respective agent chats.
- [ ] Panel deletion requires confirmation, retains persistent volumes by default, and deletes data only when explicitly selected. It stops polling the bot and removes its local binding and credential. The confirmation explains that Telegram bot identity deletion is separate.
- [ ] Messages go only to the agent bound to the receiving bot, with a clear reply when that agent is stopped or not ready.
- [ ] A bot already bound to another agent, an invalid token, a non-allowlisted owner, and unauthenticated setup requests are rejected.

### Telegram Commands

| Command | Description |
|---|---|
| `/start`, `/help` | Activate the owner's chat and display this agent's help |
| `/status` | Display this agent's status |
| `/stop` | Cancel this agent's active task (Phase 3) |
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

- [ ] Each agent conversation, identified by bot ID and private chat ID, has a persistent FIFO task queue and runs one turn at a time.
- [ ] Incoming messages and task state changes are saved before execution.
- [ ] Progress updates are sent through the originating agent bot to its owner’s bound chat while a task runs.
- [ ] `/stop` in an agent bot cancels only that agent’s running task, and the agent accepts a new task afterwards.
- [ ] Tasks have a timeout, and a failed task does not block the tasks behind it.
- [ ] Browser tasks work through Playwright, using the approach chosen in Phase 0.
- [ ] Approval requests for sensitive actions are sent through the originating agent bot and can be accepted or denied only by its authorized owner; callbacks are bound to that agent and task.

### Acceptance Criteria

- A long-running task shows progress and can be cancelled.
- Several messages sent in a row are processed in order.
- An agent can open a public website and summarize it.

---

## 10. Phase 4 — Recovery and Hardening

**Goal:** Make the self-hosted MVP reliable enough for practical use.

### Tasks

- [ ] After a server restart, agents, owners, bot credentials and bindings, polling connections, and container states are restored, and missing or stopped containers are detected.
- [ ] After an Agent Host restart, the conversation continues, and in-flight tasks are resumed or marked interrupted and reported to the user.
- [ ] Duplicate Telegram updates do not create duplicate tasks; deduplication uses bot ID and update ID, since update IDs are not shared across bots.
- [ ] Telegram, Docker, and OpenCode failures are retried a bounded number of times and then reported, without leaving the system stuck. A revoked or invalid agent bot token is shown in the panel and does not stop other agents.
- [ ] The server and Agent Hosts expose health checks and write structured logs with agent and task IDs, with secrets redacted.
- [ ] Agent containers have restricted Linux capabilities and networking, and internal APIs are not exposed outside the Docker network.
- [ ] Automated tests cover panel authentication, session expiry, CSRF protection, bot linking, owner authorization, message routing, task state transitions, restart recovery, cancellation, and multi-agent isolation.

**Security limitation:** The MVP is intended for trusted self-hosted deployments. Docker containers alone do not provide sufficient isolation for hostile multi-tenant workloads.

### Acceptance Criteria

- Restarts do not lose committed conversations or files.
- Unauthorized Telegram users cannot access agents.
- Agent Hosts do not receive host-level credentials.
- Failed tasks do not leave the system permanently blocked.

---

## 11. Phase 5 — Packaging and Release

**Goal:** Make Nimbot installable by self-hosted users.

### Tasks

- [ ] Dockerfiles for both apps, `compose.yaml`, and `.env.example` exist, with restart policies and health checks.
- [ ] A fresh install on a clean Linux server works by following the documentation alone.
- [ ] The documentation covers installation, panel administrator setup, HTTPS access, per-agent BotFather token linking and chat activation, token replacement, AI provider authentication, environment variables, and commands.
- [ ] The documentation covers backup and restore, troubleshooting, and security limitations.
- [ ] The repo has an Apache 2.0 `LICENSE`, `CONTRIBUTING.md`, and `.gitignore`.
- [ ] CI runs linting, type checking, and tests.
- [ ] The end-to-end test in section 12 passes, versioned Docker images are built, and `v0.1.0` is tagged with release notes.

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
- [ ] Panel credentials and sessions are protected, and unauthorized API requests are rejected.
- [ ] Bot tokens can be linked and replaced securely through the panel.
- [ ] Each agent has a distinct Telegram bot and owner-bound private chat.
- [ ] Tasks, progress, approvals, and results remain in the correct agent chat.
- [ ] There is no shared active-agent selection or `/use` workflow.
- [ ] Each agent runs in its own Docker container.
- [ ] Each agent has persistent storage.
- [ ] OpenCode works through ACP.
- [ ] Agents can execute terminal commands.
- [ ] Agents can read and write files.
- [ ] Agents can use a browser.
- [ ] Conversations persist across restarts.
- [ ] Tasks can be cancelled.
- [ ] Interrupted tasks are handled safely.
- [ ] Duplicate incoming messages do not execute tasks twice.
- [ ] Agent workspaces are isolated under the documented threat model.
- [ ] Automated tests cover critical workflows.
- [ ] Installation and troubleshooting documentation are complete.
- [ ] The project is released under Apache License 2.0.

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
