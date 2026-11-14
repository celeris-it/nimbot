# Nimbot — MVP Specification

**Version:** 0.1.0  
**Status:** Phase 0 in progress  
**License:** Apache License 2.0  
**Deployment:** Self-hosted  
**Primary Interface:** Telegram  
**Primary AI Engine:** OpenCode (ACP)

---

## 1. Overview

Nimbot is a self-hosted platform for creating, running, and managing persistent AI agents through messaging applications.

Users install Nimbot on their own servers and interact with their agents through Telegram.

Each agent has its own identity, instructions, conversations, persistent workspace, and execution environment.

Agents can execute commands, modify files, browse the web, and perform long-running tasks without requiring users to remain connected.

The MVP focuses on delivering a reliable, extensible, single-server installation.

### 1.1 MVP Goal

A user should be able to:

1. Install Nimbot on a Linux server using Docker Compose.
2. Connect their own Telegram bot.
3. Create and manage multiple AI agents.
4. Assign a dedicated execution environment to each agent.
5. Send tasks to agents through Telegram.
6. Allow agents to execute terminal commands, manipulate files, and use a browser.
7. Receive progress updates and task results.
8. Stop and restart agents without losing persistent data.
9. Recover conversations and pending tasks after application restarts.

### 1.2 Success Criteria

The MVP is complete when:

- Nimbot can be installed with documented Docker Compose instructions.
- Telegram can create, list, select, stop, and delete agents.
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
- Telegram integration
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

- Web dashboard
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
| HTTP Framework | Hono |
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
                    Telegram
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

- Telegram communication
- Agent registration
- Agent configuration
- Task routing
- Container lifecycle management
- User authorization
- Task status tracking
- System configuration
- Logging and diagnostics

The server must not execute agent-generated shell commands directly on the host operating system.

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

- Agents
- Agent configurations
- Telegram user permissions
- Telegram conversation routes
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

There is no agent management in this phase. One Agent Host container is defined in `compose.yaml`.

### Tasks

- [ ] The Nimbot Server starts, validates its configuration, and connects to Telegram with long polling.
- [ ] Only allowlisted Telegram user IDs get a response; everyone else is rejected.
- [ ] One Agent Host container runs with a persistent workspace volume.
- [ ] The server sends tasks to the Agent Host and receives events over an authenticated internal API.
- [ ] A text message becomes an OpenCode task, and the final answer is delivered to Telegram.
- [ ] Long answers are split to fit Telegram's message length limit.
- [ ] Errors are reported to the user in plain language.

### Acceptance Criteria

- An authorized user sends a programming task and receives the result in Telegram.
- An unauthorized user is rejected.
- Files the agent created are still there after the container restarts.

---

## 8. Phase 2 — Multiple Agents

**Goal:** Create and manage agents from Telegram, each in its own container.

### Tasks

- [ ] The server stores agents, their instructions, their containers, and each user's selected agent in SQLite, with migrations.
- [ ] The server can create, start, stop, and delete agent containers and volumes through the Docker Engine API.
- [ ] Agent containers run as non-root with CPU, memory, and process limits, and without the Docker socket or server credentials.
- [ ] `/new` asks for a name and optional instructions, provisions the agent, selects it, and reports provisioning failures.
- [ ] `/agents`, `/use`, `/status`, `/start`, and `/help` work.
- [ ] `/delete` asks for confirmation before removing an agent and its data.
- [ ] Messages go to the selected agent, with a clear reply when no agent is selected or the agent is stopped.

### Telegram Commands

| Command | Description |
|---|---|
| `/start` | Display welcome message and help |
| `/new` | Create a new agent |
| `/agents` | List existing agents |
| `/use` | Select the active agent |
| `/status` | Display agent and task status |
| `/stop` | Cancel the active task (Phase 3) |
| `/delete` | Delete an agent with confirmation |
| `/help` | Display available commands |

### Acceptance Criteria

- Two agents run independently, each with its own container and persistent volume.
- One agent cannot read another agent's workspace through its workspace or supported tools.
- Agent Hosts are reachable only from the Nimbot Server.

---

## 9. Phase 3 — Tasks, Progress, and Browser

**Goal:** Agents handle long-running work that the user can follow and stop.

### Tasks

- [ ] Each conversation has a persistent FIFO task queue and runs one turn at a time.
- [ ] Incoming messages and task state changes are saved before execution.
- [ ] Progress updates are sent to Telegram while a task runs.
- [ ] `/stop` cancels the running task, and the agent accepts a new task afterwards.
- [ ] Tasks have a timeout, and a failed task does not block the tasks behind it.
- [ ] Browser tasks work through Playwright, using the approach chosen in Phase 0.
- [ ] Approval requests for sensitive actions are shown in Telegram and can be accepted or denied.

### Acceptance Criteria

- A long-running task shows progress and can be cancelled.
- Several messages sent in a row are processed in order.
- An agent can open a public website and summarize it.

---

## 10. Phase 4 — Recovery and Hardening

**Goal:** Make the self-hosted MVP reliable enough for practical use.

### Tasks

- [ ] After a server restart, agents, selected agents, and container states are restored, and missing or stopped containers are detected.
- [ ] After an Agent Host restart, the conversation continues, and in-flight tasks are resumed or marked interrupted and reported to the user.
- [ ] Duplicate Telegram updates do not create duplicate tasks.
- [ ] Telegram, Docker, and OpenCode failures are retried a bounded number of times and then reported, without leaving the system stuck.
- [ ] The server and Agent Hosts expose health checks and write structured logs with agent and task IDs, with secrets redacted.
- [ ] Agent containers have restricted Linux capabilities and networking, and internal APIs are not exposed outside the Docker network.
- [ ] Automated tests cover authorization, message routing, task state transitions, restart recovery, cancellation, and multi-agent isolation.

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
- [ ] The documentation covers installation, Telegram bot creation, AI provider authentication, environment variables, and commands.
- [ ] The documentation covers backup and restore, troubleshooting, and security limitations.
- [ ] The repo has an Apache 2.0 `LICENSE`, `CONTRIBUTING.md`, and `.gitignore`.
- [ ] CI runs linting, type checking, and tests.
- [ ] The end-to-end test in section 12 passes, versioned Docker images are built, and `v0.1.0` is tagged with release notes.

### Acceptance Criteria

- A user can install Nimbot, connect a Telegram bot, authenticate the AI provider, and operate agents using only the documentation.

---

## 12. End-to-End MVP Acceptance Test

The following scenario must work before releasing `v0.1.0`.

### Scenario: Two Persistent Agents

**Step 1 — Installation**

Install Nimbot on a Linux server using Docker Compose.

**Expected:** The Nimbot Server starts successfully and connects to Telegram.

**Step 2 — Create Agent A**

Send:

`/new`

Create an agent named `developer`.

**Expected:** Nimbot creates an Agent Host with a dedicated persistent workspace.

**Step 3 — Execute a Task**

Send:

`Create a Python script that generates a CSV file containing 100 random numbers.`

**Expected:** The agent creates the file and reports completion.

**Step 4 — Verify Persistence**

Restart the Agent Host.

Send:

`Read the CSV file you created earlier and calculate its average.`

**Expected:** The file still exists and the agent can access it.

**Step 5 — Create Agent B**

Create an agent named `researcher`.

**Expected:** A separate Agent Host and workspace are created.

**Step 6 — Verify Isolation**

Ask Agent B to list its workspace.

**Expected:** Agent B cannot access Agent A's files through its assigned workspace or supported tools.

**Step 7 — Browser Task**

Ask Agent B to open a public website and summarize its contents.

**Expected:** The browser launches and the agent returns a summary.

**Step 8 — Restart Nimbot**

Restart the Nimbot Server and both Agent Hosts.

**Expected:** Agents, conversations, workspaces, and configurations remain available.

**Step 9 — Cancel a Task**

Start a long-running task and send `/stop`.

**Expected:** The running task is cancelled or safely terminated, and the agent can accept a new task.

**Step 10 — Authorization**

Send a command from an unauthorized Telegram account.

**Expected:** Access is rejected without exposing agent data.

---

## 13. MVP Definition of Done

Nimbot `v0.1.0` is complete when all of the following are true:

- [ ] Installation works through Docker Compose.
- [ ] Telegram integration works.
- [ ] Telegram authorization works.
- [ ] Users can create multiple agents.
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
- Multiple Telegram bots
- Group conversation support
- File and media attachments
- Voice messages

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

- Web dashboard
- Agent templates
- Agent configuration editor
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

**3. One agent, one execution environment.** Agents must not share workspaces or execution processes by default.

**4. Engine independence.** Agent management must not be tightly coupled to OpenCode.

**5. Messaging independence.** Telegram-specific logic must remain outside the core agent runtime.

**6. Durable execution.** Messages and tasks must be persisted before execution whenever possible.

**7. Explicit failure handling.** Errors, cancellations, and interrupted tasks must have defined behavior.

**8. Minimal dependencies.** Prefer SQLite and Docker over unnecessary external services.

**9. Secure defaults.** Do not expose internal APIs, host credentials, or Docker access to agent workloads.

**10. Incremental delivery.** Each implementation phase must produce a testable, working component.

---

**Nimbot — Your AI agents, always in the cloud.**
