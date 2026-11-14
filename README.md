# Nimbot

**Your AI agents, on your own server.**

Nimbot is a self-hosted platform for creating, running, and managing persistent AI agents through Telegram.

You install Nimbot on a Linux server with Docker Compose, connect your own Telegram bot, and talk to your agents from your phone. Each agent runs in its own Docker container with a persistent workspace, a terminal, and a browser, and keeps working on long-running tasks while you are offline.

> **Project status:** Planning. Nothing is implemented yet. This README describes the intended `v0.1.0`; the full plan is in [MVP.md](MVP.md).

## What the MVP does

- Create and manage multiple agents from Telegram (`/new`, `/agents`, `/use`, `/status`, `/stop`, `/delete`)
- Give each agent its own Docker container and persistent workspace
- Let agents run terminal commands, read and write files, and use a browser
- Send progress updates and final results back to Telegram
- Cancel a running task
- Keep conversations, files, and pending tasks across restarts
- Restrict access to an allowlist of Telegram user IDs

Out of scope for the MVP: web dashboard, other messaging channels, other AI engines, multi-server deployments, and hosted multi-tenant use. See the [post-MVP backlog](MVP.md#14-post-mvp-backlog).

## Architecture

One Nimbot Server manages one container per agent on the same machine.

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

- **Nimbot Server** handles Telegram, user authorization, the agent registry, task routing, and container lifecycle. It never runs agent-generated commands on the host.
- **Agent Host** is one container per agent. It runs the AI engine, executes tasks, and owns the agent's workspace and conversation state.
- **Storage** is SQLite plus Docker volumes. No PostgreSQL, Redis, or message broker is required.

## Technology

TypeScript on Node.js LTS, pnpm, Hono, grammY, Drizzle with SQLite, Docker, Playwright, and Vitest. The AI engine is [OpenCode](https://opencode.ai), driven through the Agent Client Protocol (ACP).

## Security

The MVP is intended for trusted, self-hosted use. Agent containers run as non-root with resource limits and no access to the Docker socket or server credentials.

Docker containers alone are not a sufficient isolation boundary for hostile or multi-tenant workloads.

## Roadmap

| Phase | Goal |
|---|---|
| 0 | Validate OpenCode through ACP inside Docker |
| 1 | One pre-configured agent answering over Telegram |
| 2 | Multiple agents, created and managed from Telegram |
| 3 | Task queue, progress updates, cancellation, and browser |
| 4 | Recovery and hardening |
| 5 | Packaging and `v0.1.0` release |

Details and acceptance criteria for each phase are in [MVP.md](MVP.md).

## Inspiration

Nimbot takes architectural inspiration from [OpenBot](https://github.com/nightly-labs/openbot). It is an independent project and does not reuse OpenBot's source code, which is distributed under the PolyForm Noncommercial License 1.0.0.

## Contributing

Contribution guidelines and development setup will be added once there is code to contribute to.

## License

Nimbot will be released under the Apache License 2.0.
