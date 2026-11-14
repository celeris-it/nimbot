# Nimbot

**Your AI agents, always in the cloud.**

Nimbot is an open-source-oriented, cloud-first platform for creating, running, and managing persistent AI agents through messaging applications.

Each agent operates in its own isolated cloud computer, with access to a filesystem, terminal, browser, and AI coding engines such as OpenCode, Codex, and Claude Code.

Nimbot is designed to make autonomous AI agents accessible without requiring users to configure servers, containers, or development environments.

> **Project status:** Early development. The architecture and specifications are being established. Features described below represent the intended design and are not necessarily implemented yet.

## Vision

AI agents should be more than chatbots.

They should have their own computers, persistent workspaces, tools, and the ability to perform tasks independently.

Nimbot aims to make this possible through a simple messaging interface.

Instead of configuring infrastructure, users should be able to create an agent, assign a task, and let it work.

**One agent. One computer. Accessible from anywhere.**

## Core Features

### Persistent AI Agents

Create agents with their own identity, instructions, memory, conversations, and workspace.

Agents are designed to retain their state across tasks, sessions, and computer restarts.

### Isolated Cloud Computers

Each agent runs inside a dedicated computing environment with:

- Persistent filesystem and workspace
- Terminal and command execution
- Python and Node.js runtimes
- Browser automation with Playwright
- Configurable CPU, memory, and storage limits
- Independent processes and execution state

Computers can be started and stopped without deleting their persistent data.

### Multiple AI Engines

Nimbot is designed to support different AI agent engines through a common interface.

Planned integrations include:

- **OpenCode** — Initial integration through Agent Client Protocol (ACP)
- **OpenAI Codex** — Native SDK integration
- **Claude Code** — Future integration
- **Other ACP-compatible agents** — Extensible through a generic ACP adapter

AI engines are interchangeable execution backends, while Nimbot manages agent identity, persistence, messaging, and infrastructure.

Provider-specific capabilities and session compatibility may vary.

### Messaging-First Experience

Manage agents directly from messaging applications.

**Initial channel:**
- Telegram

**Planned channels:**
- WhatsApp
- Web interface
- Additional messaging platforms

Messaging adapters are independent from the agent runtime, allowing new channels to be added without modifying the core execution system.

### Background Task Execution

Agents can execute long-running tasks without requiring users to remain connected.

The execution system is designed to support:

- Persistent task queues
- Asynchronous execution
- Progress updates
- Cancellation
- Human approval requests
- Failure recovery
- Scheduled tasks and automations

### Persistent Memory and Conversations

Each agent maintains its own conversation history, execution events, memories, and provider sessions.

Nimbot separates global platform metadata from agent-local state to keep execution environments independent.

## Architecture

Nimbot follows a distributed architecture consisting of a central **Control Plane** and independent **Agent Hosts**.

```text
                  Messaging Channels
                ┌─────────────────────┐
                │ Telegram / WhatsApp │
                └──────────┬──────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │   Channel Gateway   │
                └──────────┬──────────┘
                           │
                           ▼
              ┌──────────────────────────┐
              │   Nimbot Control Plane   │
              │                          │
              │  - Account Management    │
              │  - Agent Registry        │
              │  - Host Registry         │
              │  - Task Routing          │
              │  - Computer Provisioning │
              │  - Event Relay           │
              └────────────┬─────────────┘
                           │
                    PostgreSQL
                           │
              ┌────────────┴─────────────┐
              │                          │
              ▼                          ▼
       ┌──────────────┐           ┌──────────────┐
       │  Agent Host  │           │  Agent Host  │
       │              │           │              │
       │ AgentService │           │ AgentService │
       │ Task Queue   │           │ Task Queue   │
       │ Event Store  │           │ Event Store  │
       │ Tool Router  │           │ Tool Router  │
       │ AI Engine    │           │ AI Engine    │
       └──────┬───────┘           └──────┬───────┘
              │                          │
              ▼                          ▼
       ┌──────────────┐           ┌──────────────┐
       │  Persistent  │           │  Persistent  │
       │  Workspace   │           │  Workspace   │
       │  + SQLite    │           │  + SQLite    │
       └──────────────┘           └──────────────┘
```

### Control Plane

The Control Plane manages platform-wide operations, including:

- User accounts and authorization
- Agent registration and configuration
- Computer provisioning and lifecycle
- Channel routing
- Host discovery and health monitoring
- Task dispatching
- Platform-level metadata

The Control Plane does not directly execute AI agent workloads.

### Agent Host

An Agent Host is an autonomous runtime responsible for executing agents and managing their local state.

Each host provides:

- Agent lifecycle management
- Conversation and session management
- Persistent task queues
- AI engine adapters
- Tool discovery and execution
- Event storage
- Memory management
- Workspace management
- Task scheduling

The initial architecture assigns one isolated host to each agent.

### AI Engine Layer

Nimbot uses a provider-independent engine interface.

ACP-compatible engines communicate through a generic adapter, while engines requiring additional capabilities can use native integrations.

The engine layer normalizes execution events, tool calls, errors, approvals, and cancellation.

### Storage

Nimbot uses two storage layers:

| Storage | Purpose |
|---|---|
| PostgreSQL | Accounts, agent registry, host registry, channel routes, and platform metadata |
| SQLite | Agent conversations, task queues, execution events, memories, and local sessions |
| Persistent volumes | Agent files, workspace data, and provider runtime state |

Each host owns its local database and persistent workspace.

## Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js LTS |
| Package manager | pnpm |
| HTTP framework | Hono |
| Telegram integration | grammY |
| Database ORM | Drizzle |
| Central database | PostgreSQL |
| Host database | SQLite |
| Agent protocol | ACP |
| Browser automation | Playwright |
| Container runtime | Docker |
| Testing | Vitest |

The stack may evolve as the implementation progresses.

## Security Model

Nimbot is designed around isolated execution environments.

The intended security model includes:

- Dedicated workspaces and persistent storage per agent
- Non-root container execution
- Resource limits
- Restricted filesystem access
- Network access controls
- Secure credential management
- Human approval for sensitive operations
- Authenticated communication between hosts and the Control Plane
- Execution and security event logging

**Security note:** Docker containers alone are not considered a sufficient isolation boundary for untrusted multi-tenant workloads. Public multi-tenant deployment will require stronger isolation, such as microVMs or equivalent sandboxing.

## Project Structure

The proposed monorepo structure is:

```text
nimbot/
├── apps/
│   ├── control-plane/
│   ├── channel-gateway/
│   └── host/
│
├── packages/
│   ├── contracts/
│   ├── agent-core/
│   ├── provider-acp/
│   ├── provider-codex/
│   ├── channel-telegram/
│   ├── channel-whatsapp/
│   ├── host-client/
│   ├── event-store/
│   ├── security/
│   └── logging/
│
├── infrastructure/
│   ├── docker/
│   └── migrations/
│
├── tests/
│   ├── integration/
│   └── e2e/
│
└── docs/
    ├── architecture.md
    ├── protocols.md
    ├── security.md
    └── roadmap.md
```

This structure represents the intended organization and may change during development.

## Development Roadmap

### Phase 1 — Agent Host

- [ ] Implement the Agent Host runtime
- [ ] Integrate OpenCode through ACP
- [ ] Implement SQLite persistence
- [ ] Add conversation and event storage
- [ ] Implement persistent task execution
- [ ] Support workspace persistence across restarts

### Phase 2 — Telegram Integration

- [ ] Implement the Telegram channel adapter
- [ ] Add agent creation and management commands
- [ ] Route messages to the correct agent
- [ ] Implement asynchronous task execution
- [ ] Deliver progress updates and results
- [ ] Support task cancellation

### Phase 3 — Cloud Computers

- [ ] Implement the Control Plane
- [ ] Add computer provisioning through Docker
- [ ] Create isolated agent environments
- [ ] Add computer lifecycle management
- [ ] Implement persistent volumes
- [ ] Support multiple concurrent agents

### Phase 4 — Engines and Automation

- [ ] Add native Codex integration
- [ ] Implement scheduled tasks
- [ ] Add human approval workflows
- [ ] Improve task recovery and session resumption
- [ ] Expand ACP engine compatibility

### Phase 5 — Cloud Platform

- [ ] Implement multi-user authentication
- [ ] Add stronger multi-tenant isolation
- [ ] Integrate WhatsApp
- [ ] Add usage monitoring
- [ ] Implement billing
- [ ] Add a web management interface

## Design Principles

**Messaging first.** Users should be able to manage agents without opening a dashboard.

**Persistent by default.** Agent files, memories, and conversations should survive restarts.

**Engine agnostic.** AI providers should remain replaceable.

**Isolation by design.** Agent workloads should not share execution environments by default.

**Simple infrastructure.** Avoid unnecessary distributed systems and infrastructure dependencies during early development.

**Recoverable execution.** Tasks and messages should survive transient failures whenever possible.

**Extensible architecture.** New channels, AI engines, and computer providers should be integrated through stable interfaces.

## Inspiration

Nimbot takes architectural inspiration from [OpenBot](https://github.com/nightly-labs/openbot), particularly its agent runtime, provider adapters, event persistence, messaging integrations, and task execution model.

Nimbot is an independent project with a cloud-first architecture focused on isolated agent computers and messaging-based management.

OpenBot's source code is distributed under the PolyForm Noncommercial License 1.0.0. Nimbot does not assume permission to reuse that code for commercial purposes.

## Contributing

Nimbot is in early development.

Contribution guidelines, development setup instructions, and issue templates will be added as the project matures.

## License

The license for Nimbot has not yet been selected.

---

**Nimbot — Your AI agents, always in the cloud.**
