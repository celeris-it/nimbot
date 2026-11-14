# Nimbot — MVP Specification

**Version:** 0.1.0  
**Status:** Planning  
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
- Agent memory
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
│   ├── agent-core/
│   ├── provider-acp/
│   ├── channel-telegram/
│   ├── event-store/
│   ├── container-manager/
│   ├── security/
│   └── logging/
│
├── infrastructure/
│   └── docker/
│
├── tests/
│   ├── integration/
│   └── e2e/
│
├── docs/
│   ├── architecture.md
│   ├── agents.md
│   ├── providers.md
│   ├── messaging.md
│   ├── execution.md
│   ├── security.md
│   └── MVP.md
│
├── compose.yaml
├── package.json
├── pnpm-workspace.yaml
├── README.md
└── LICENSE
```

---

## 6. Phase 0 — Technical Validation

**Goal:** Validate the most important technical dependency before implementing the platform.

### Tasks

- [ ] Initialize the TypeScript monorepo.
- [ ] Configure Node.js LTS and pnpm.
- [ ] Configure TypeScript strict mode.
- [ ] Configure ESLint and Prettier.
- [ ] Configure Vitest.
- [ ] Create a minimal Docker image for the Agent Host.
- [ ] Install OpenCode inside the container.
- [ ] Investigate and validate the OpenCode ACP interface.
- [ ] Implement a minimal ACP client.
- [ ] Start an OpenCode session programmatically.
- [ ] Send a prompt to OpenCode.
- [ ] Receive streaming responses.
- [ ] Execute a filesystem operation.
- [ ] Execute a terminal command.
- [ ] Verify session persistence after restarting the process.
- [ ] Verify cancellation behavior.
- [ ] Document limitations and supported ACP capabilities.

### Acceptance Criteria

- OpenCode can receive and execute a task through ACP.
- Responses and tool execution events are observable.
- The workspace persists after a restart.
- The integration works inside Docker.
- Unsupported ACP capabilities are documented.

---

## 7. Phase 1 — Agent Host Runtime

**Goal:** Build a persistent and independently executable agent environment.

### 7.1 Agent Runtime

- [ ] Implement `AgentService`.
- [ ] Implement `ConversationService`.
- [ ] Implement `ProviderManager`.
- [ ] Implement `WorkspaceManager`.
- [ ] Implement `EventStore`.
- [ ] Implement `TaskExecutor`.
- [ ] Implement `TaskScheduler`.
- [ ] Implement `ToolRouter`.
- [ ] Implement `MemoryService` with basic persistent storage.
- [ ] Implement Agent Host configuration.
- [ ] Implement host startup and shutdown lifecycle.
- [ ] Implement health checks.

### 7.2 ACP Integration

- [ ] Create an `AgentEngine` interface.
- [ ] Implement `AcpEngine`.
- [ ] Support prompt submission.
- [ ] Support streaming output.
- [ ] Support tool execution events.
- [ ] Support session identifiers.
- [ ] Support session resumption where available.
- [ ] Support cancellation.
- [ ] Normalize provider errors.
- [ ] Normalize execution events.
- [ ] Define provider capability detection.

### 7.3 Persistent Storage

- [ ] Create the Agent Host SQLite schema.
- [ ] Implement database migrations.
- [ ] Enable SQLite WAL mode where appropriate.
- [ ] Persist conversations.
- [ ] Persist messages.
- [ ] Persist task execution events.
- [ ] Persist provider session identifiers.
- [ ] Persist agent configuration.
- [ ] Persist task states.
- [ ] Implement startup recovery.
- [ ] Implement database integrity checks.
- [ ] Document backup and restore procedures.

### 7.4 Task Execution

- [ ] Implement a persistent task queue.
- [ ] Implement FIFO ordering per conversation.
- [ ] Prevent overlapping turns within the same conversation.
- [ ] Implement task status transitions.
- [ ] Implement task cancellation.
- [ ] Implement execution timeouts.
- [ ] Implement bounded retries.
- [ ] Implement interrupted-task recovery.
- [ ] Implement idempotency keys.
- [ ] Persist task results before delivery.
- [ ] Ensure failed tasks do not block subsequent tasks indefinitely.

### 7.5 Tools and Workspace

- [ ] Provide a persistent workspace directory.
- [ ] Enable filesystem operations.
- [ ] Enable terminal command execution.
- [ ] Integrate Playwright.
- [ ] Install and configure a supported browser.
- [ ] Implement browser startup and cleanup.
- [ ] Configure workspace access boundaries.
- [ ] Implement tool execution logging.
- [ ] Implement basic approval handling for sensitive actions.
- [ ] Validate resource usage during browser execution.

### Acceptance Criteria

- An Agent Host runs independently inside Docker.
- OpenCode can execute filesystem, terminal, and browser tasks.
- Conversations and files persist across restarts.
- Task events are stored and retrievable.
- Cancellation works for supported operations.
- Interrupted tasks are recovered or explicitly marked interrupted.
- The host exposes a working health endpoint.

---

## 8. Phase 2 — Nimbot Server

**Goal:** Manage multiple Agent Hosts from one self-hosted application.

### 8.1 Server Foundation

- [ ] Create the Nimbot Server application.
- [ ] Configure Hono.
- [ ] Implement application configuration.
- [ ] Implement environment variable validation.
- [ ] Implement structured logging.
- [ ] Implement graceful shutdown.
- [ ] Implement health checks.
- [ ] Create the server SQLite schema.
- [ ] Implement database migrations.

### 8.2 Agent Management

- [ ] Implement `AgentRegistry`.
- [ ] Implement agent creation.
- [ ] Implement agent listing.
- [ ] Implement agent selection.
- [ ] Implement agent configuration updates.
- [ ] Implement agent deletion.
- [ ] Implement agent status reporting.
- [ ] Generate unique agent identifiers.
- [ ] Validate agent names.
- [ ] Persist agent instructions.
- [ ] Persist agent-to-container mappings.

### 8.3 Docker Integration

- [ ] Implement `ContainerManager`.
- [ ] Connect to Docker Engine API.
- [ ] Create Agent Host containers.
- [ ] Start Agent Host containers.
- [ ] Stop Agent Host containers.
- [ ] Restart Agent Host containers.
- [ ] Delete Agent Host containers.
- [ ] Create persistent volumes.
- [ ] Mount agent-specific volumes.
- [ ] Configure container resource limits.
- [ ] Configure container networking.
- [ ] Implement container health monitoring.
- [ ] Recover container state after server restarts.
- [ ] Handle missing or unexpectedly stopped containers.
- [ ] Prevent accidental deletion of persistent data.

### 8.4 Server-to-Host Communication

- [ ] Define the internal Host API.
- [ ] Implement authenticated requests.
- [ ] Implement task submission.
- [ ] Implement task status retrieval.
- [ ] Implement event streaming or polling.
- [ ] Implement task cancellation.
- [ ] Implement host health checks.
- [ ] Implement request timeouts.
- [ ] Implement retry behavior.
- [ ] Implement protocol version negotiation.
- [ ] Validate all incoming and outgoing payloads.

### Acceptance Criteria

- The server can create and manage multiple Agent Hosts.
- Each agent has its own container and persistent volume.
- Agents cannot access each other's workspaces through supported application interfaces.
- Agent state survives Nimbot Server restarts.
- The server can communicate reliably with running hosts.

---

## 9. Phase 3 — Telegram Integration

**Goal:** Provide the complete user experience through Telegram.

### 9.1 Telegram Adapter

- [ ] Integrate grammY.
- [ ] Configure Telegram bot token.
- [ ] Implement long polling for self-hosted deployment.
- [ ] Implement Telegram user authorization.
- [ ] Support an allowlist of authorized Telegram user IDs.
- [ ] Reject unauthorized users.
- [ ] Normalize incoming Telegram messages.
- [ ] Implement outgoing message delivery.
- [ ] Implement Telegram API error handling.
- [ ] Implement message deduplication.
- [ ] Implement rate-limit handling.
- [ ] Implement basic message formatting.

### 9.2 Telegram Commands

| Command | Description |
|---|---|
| `/start` | Display welcome message and help |
| `/new` | Create a new agent |
| `/agents` | List existing agents |
| `/use` | Select the active agent |
| `/status` | Display agent and task status |
| `/stop` | Cancel the active task |
| `/delete` | Delete an agent with confirmation |
| `/help` | Display available commands |

### 9.3 Agent Creation Flow

- [ ] Implement the `/new` command.
- [ ] Request an agent name.
- [ ] Request optional agent instructions.
- [ ] Create the agent record.
- [ ] Provision the Agent Host container.
- [ ] Initialize the workspace.
- [ ] Initialize OpenCode.
- [ ] Report agent readiness.
- [ ] Select the new agent automatically.
- [ ] Handle provisioning failures.

### 9.4 Messaging and Tasks

- [ ] Route incoming messages to the selected agent.
- [ ] Persist incoming messages before execution.
- [ ] Submit tasks to the Agent Host.
- [ ] Return task acknowledgment.
- [ ] Stream or periodically send progress updates.
- [ ] Deliver final responses.
- [ ] Handle long Telegram messages.
- [ ] Handle Telegram message length limits.
- [ ] Implement task cancellation through `/stop`.
- [ ] Report errors in user-friendly language.
- [ ] Restore active agent selection after restart.
- [ ] Prevent duplicate task execution from repeated updates.

### 9.5 User Experience

- [ ] Provide clear command descriptions.
- [ ] Display agent status consistently.
- [ ] Display running task indicators.
- [ ] Confirm destructive actions.
- [ ] Handle invalid commands.
- [ ] Handle messages when no agent is selected.
- [ ] Handle messages when an agent is stopped.
- [ ] Provide meaningful error messages.
- [ ] Document the complete Telegram workflow.

### Acceptance Criteria

An authorized user can:

1. Open Telegram.
2. Send `/new`.
3. Create an agent named `developer`.
4. Send a programming task.
5. Receive progress updates.
6. Receive the final result.
7. Stop the agent.
8. Restart the agent.
9. Continue the previous conversation.
10. Create a second independent agent.

---

## 10. Phase 4 — Reliability and Security

**Goal:** Make the self-hosted MVP reliable enough for practical use.

### 10.1 Reliability

- [ ] Implement automatic recovery after application restarts.
- [ ] Implement container restart reconciliation.
- [ ] Implement task timeout handling.
- [ ] Implement retry limits.
- [ ] Implement dead-letter or failed-task handling.
- [ ] Prevent duplicate task submission.
- [ ] Implement graceful process termination.
- [ ] Handle database connection failures.
- [ ] Handle Docker Engine failures.
- [ ] Handle Telegram API failures.
- [ ] Handle OpenCode crashes.
- [ ] Implement health checks for critical components.

### 10.2 Security

- [ ] Require Telegram user authorization.
- [ ] Validate all incoming commands.
- [ ] Authenticate Server-to-Host communication.
- [ ] Run Agent Hosts as non-root users.
- [ ] Restrict Linux capabilities.
- [ ] Configure container CPU limits.
- [ ] Configure container memory limits.
- [ ] Configure process limits.
- [ ] Configure storage limits where supported.
- [ ] Prevent access to the Docker socket from Agent Hosts.
- [ ] Prevent access to server credentials from Agent Hosts.
- [ ] Isolate agent volumes.
- [ ] Restrict unnecessary container networking.
- [ ] Prevent accidental exposure of internal APIs.
- [ ] Redact secrets from logs.
- [ ] Avoid storing credentials in plaintext when practical.
- [ ] Document the Docker security limitations.

**Security limitation:** The MVP is intended for trusted self-hosted deployments. Docker containers alone do not provide sufficient isolation for hostile multi-tenant workloads.

### 10.3 Observability

- [ ] Implement structured JSON logs.
- [ ] Include correlation IDs in requests.
- [ ] Include agent IDs in execution logs.
- [ ] Include task IDs in execution logs.
- [ ] Log task state transitions.
- [ ] Log container lifecycle events.
- [ ] Log provider failures.
- [ ] Implement basic runtime metrics.
- [ ] Document troubleshooting procedures.

### 10.4 Testing

- [ ] Add unit tests for Agent Registry.
- [ ] Add unit tests for task state transitions.
- [ ] Add unit tests for message routing.
- [ ] Add unit tests for authorization.
- [ ] Add integration tests for SQLite persistence.
- [ ] Add integration tests for Docker lifecycle.
- [ ] Add integration tests for ACP.
- [ ] Add integration tests for Telegram routing.
- [ ] Add restart recovery tests.
- [ ] Add task cancellation tests.
- [ ] Add multi-agent isolation tests.
- [ ] Add end-to-end tests for the main user journey.

### Acceptance Criteria

- Application restarts do not lose committed conversations or files.
- Duplicate Telegram updates do not create duplicate tasks.
- Unauthorized Telegram users cannot access agents.
- Agent Hosts do not receive host-level credentials.
- Failed tasks do not leave the system permanently blocked.
- Critical application flows have automated tests.

---

## 11. Phase 5 — Packaging and Release

**Goal:** Make Nimbot installable and maintainable by self-hosted users.

### 11.1 Docker Packaging

- [ ] Create the Nimbot Server Dockerfile.
- [ ] Create the Agent Host Dockerfile.
- [ ] Create `compose.yaml`.
- [ ] Configure persistent volumes.
- [ ] Configure environment variables.
- [ ] Create `.env.example`.
- [ ] Configure Docker restart policies.
- [ ] Configure container health checks.
- [ ] Verify container startup ordering.
- [ ] Verify clean installation.
- [ ] Verify upgrades preserve persistent data.

### 11.2 Documentation

- [ ] Complete `README.md`.
- [ ] Create installation instructions.
- [ ] Document Telegram bot creation.
- [ ] Document AI provider authentication.
- [ ] Document environment variables.
- [ ] Document agent management commands.
- [ ] Document data persistence.
- [ ] Document backup and restore.
- [ ] Document upgrade procedures.
- [ ] Document troubleshooting.
- [ ] Document security limitations.
- [ ] Add architecture documentation.
- [ ] Add developer contribution instructions.

### 11.3 Release Preparation

- [ ] Add Apache License 2.0 `LICENSE` file.
- [ ] Add `CONTRIBUTING.md`.
- [ ] Add `.gitignore`.
- [ ] Add CI workflows.
- [ ] Configure automated tests.
- [ ] Configure TypeScript type checking.
- [ ] Configure linting.
- [ ] Build versioned Docker images.
- [ ] Test fresh installation.
- [ ] Test upgrade from a previous build.
- [ ] Test persistent volume recovery.
- [ ] Create release notes.
- [ ] Tag `v0.1.0`.

### Acceptance Criteria

- A user can install Nimbot using documented instructions.
- A user can connect a Telegram bot.
- A user can authenticate the configured AI provider.
- A user can create and operate agents.
- Application upgrades preserve persistent state.
- The release includes sufficient documentation for self-hosted operation.

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
