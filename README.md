# Nimbot

**Your AI agents, on your own server.**

Nimbot is a self-hosted platform for creating and managing persistent AI agents through a web panel and talking to them through Telegram.

You install Nimbot on a Linux server with Docker Compose, sign in to a minimal administration panel, link a bot created in BotFather for each agent, and talk to each agent through its own distinct Telegram bot and private chat. Each agent runs in its own Docker container with a persistent workspace, a terminal, and a browser, and keeps working on long-running tasks while you are offline.

> **Project status:** Phase 1 in progress. Docker/ACP validation is complete. The initial Telegram server supports configuration validation, a user allowlist, and `/start` and `/help`; the administration panel, per-agent bot bindings, and task execution over Telegram are still pending. This README describes the intended `v0.1.0`; the full plan is in [MVP.md](MVP.md).

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

## Technology

TypeScript on Node.js LTS, pnpm, Hono, grammY, Drizzle with SQLite, Docker, Playwright, and Vitest. The AI engine is [OpenCode](https://opencode.ai), driven through the Agent Client Protocol (ACP).

The Agent Host image includes Playwright and headless Chromium. During Phase 0, OpenCode uses its container terminal to run the browser probe (`node /app/apps/agent-host/dist/browser-demo.js <url>`); no host browser or external MCP server is needed. The probe returns the page title and text. The demo waits up to two seconds for engine shutdown before forcing termination.

## Security

The MVP is intended for trusted, self-hosted use. The panel requires administrator authentication; remote access requires HTTPS. Telegram access requires both the allowlist and the agent’s configured owner. Deleting an agent retains its persistent volume unless data deletion is explicitly confirmed. Agent containers run as non-root with resource limits and no access to the Docker socket or server credentials.

Docker containers alone are not a sufficient isolation boundary for hostile or multi-tenant workloads.

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

Run `pnpm install`, then `pnpm build`. Before submitting changes, run `pnpm lint`, `pnpm typecheck`, and `pnpm test`.

The Telegram server reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` (comma-separated numeric IDs) from environment variables or the root `.env`; `.env.example` lists the required settings. Start the compiled server with `pnpm start:server`. The current implementation still uses a single bot and handles private chats for allowlisted users. The MVP now requires an authenticated panel and a distinct bot per agent; panel administration and Agent Host routing still need implementation. The existing environment variables describe the current prototype, not the future panel configuration. Users must open each agent bot and press Start before it can send notifications; delivery uses Telegram chat IDs, not phone numbers.

## License

Nimbot will be released under the Apache License 2.0.
