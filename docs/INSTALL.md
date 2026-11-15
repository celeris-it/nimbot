# Installing Nimbot

Nimbot runs on one Linux server with Docker Compose. The Nimbot Server hosts the administration panel and every Telegram bot connection. Each agent runs in its own Agent Host container with its own workspace volume.

Before you start, read the security limits in [MVP.md](../MVP.md) section 10: Nimbot is for trusted, self-hosted use, and giving the server access to the Docker socket is equivalent to root on the host.

## 1. Requirements

- A Linux server with Docker Engine 27 or newer and the Docker Compose plugin (`docker compose version`).
- Node.js 22.13 or newer on the machine where you generate the panel password hash (or use the container method below).
- A Telegram account, and the numeric Telegram user IDs of everyone who may own agents (message `@userinfobot` to find yours).
- An account with an AI provider supported by OpenCode, or a free OpenCode model.

## 2. Get the code and build

```sh
git clone https://github.com/<your-fork-or-org>/nimbot.git
cd nimbot
docker compose build
```

This builds the server image and the Agent Host image. (Compose names them `<directory>-server` and `<directory>-agent-host`; the commands below use the explicit tags `nimbot-server` and `nimbot-agent-host`.)

```sh
docker build -f infrastructure/docker/server.Dockerfile -t nimbot-server .
docker build -f infrastructure/docker/agent-host.Dockerfile -t nimbot-agent-host .
```

## 3. Panel administrator

The panel has one administrator. Its password is stored only as a hash.

```sh
docker run --rm -it nimbot-server node apps/server/dist/password.js
```

Enter a password of at least 12 characters twice. Copy the printed `PANEL_PASSWORD_HASH=...` line. If you prefer to run it outside Docker, use `pnpm install && pnpm build && pnpm panel:password`.

## 4. Configure

```sh
cp .env.example .env
openssl rand -hex 32     # use the output as AGENT_HOST_TOKEN
```

Edit `.env`:

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token of the first bot, from BotFather (section 6). |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric user IDs allowed to use Nimbot. Required; everyone else is rejected. |
| `TELEGRAM_OWNER_USER_ID` | Owner of the first agent. Optional when only one user is allowed. |
| `AGENT_ID`, `AGENT_NAME` | Identifier and display name of the first agent. |
| `PANEL_PASSWORD_HASH` | Hash from section 3. |
| `PANEL_URL` | Public origin of the panel, for example `https://nimbot.example.com`. Form submissions from any other origin are rejected. |
| `AGENT_HOST_TOKEN` | Internal API key for the first Agent Host, at least 32 characters. Never reuse another credential. |
| `TASK_TIMEOUT_SECONDS` | Maximum run time of one task, 10–3600 (default 600). |
| `SERVER_STATE_DIR` | State directory for native runs only; Compose uses a named volume. |

The remaining variables in `.env.example` (`DOCKER_SOCKET_PATH`, `AGENT_CONTAINER_NAME`, `DOCKER_SOCKET_GID`, `AGENT_HOST_IMAGE`, `SERVER_CONTAINER_NAME`) are explained in section 8. Do not commit `.env`.

## 5. Start and sign in

```sh
docker compose up -d
docker compose ps          # both services should become "healthy"
docker compose logs -f server
```

The panel listens on `127.0.0.1:3000` only. Open it through the HTTPS setup below, or temporarily through an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 you@server`, then <http://localhost:3000>) with `PANEL_URL=http://localhost:3000`. Sign in with the password from section 3. Five failed attempts within fifteen minutes lock further attempts for the rest of that window, and sessions last eight hours.

### HTTPS

Do not expose the panel over plain HTTP. Put a reverse proxy that terminates TLS in front of `127.0.0.1:3000`, set `PANEL_URL` to the public HTTPS origin, and run `docker compose up -d` again. With Caddy:

```text
nimbot.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Cookies are marked `Secure` automatically when `PANEL_URL` is HTTPS.

## 6. Link an agent bot (BotFather) and activate the chat

Every agent has its own bot; Nimbot has no management bot and no shared selected agent.

1. In Telegram, open `@BotFather`, send `/newbot`, and follow the prompts. Copy the token.
2. For the first agent, put the token in `TELEGRAM_BOT_TOKEN` and restart (`docker compose up -d`).
3. For additional agents, enable provisioning (section 8), open **Create agent** in the panel, and enter a name, optional instructions, the owner's Telegram user ID, and the BotFather token. The server checks the token with Telegram, rejects bots already bound to another agent, and then creates the container, volumes, and private network.
4. The setup page shows provisioning, bot polling, and owner activation separately. When the bot is polling, the owner opens the bot link and presses **Start**. Only then can tasks run.

A bot token belongs to exactly one agent. Another allowlisted user cannot use or activate an agent they do not own.

### Replacing a token

If a token is revoked or rotated in BotFather, open the agent's setup page, choose the token replacement form, and submit the new token. It must belong to the same bot. Then restart the server (`docker compose restart server`); replacement takes effect after restart. The old token is never displayed.

## 7. Authenticate the AI provider

Agents use OpenCode inside their container. Credentials are stored in that agent's own engine-state volume, so each agent is authenticated separately and credentials never pass through the server or the panel.

First agent (Compose service `agent-host`):

```sh
docker compose exec -it agent-host opencode auth login
docker compose exec agent-host opencode auth list
```

Agents created in the panel run in containers named `nimbot-<agent-id>` (the ID appears in the panel and in `docker ps`):

```sh
docker exec -it nimbot-<agent-id> opencode auth login
```

Pick a provider and paste its key when asked. Readiness in the panel does not verify provider access; if tasks fail, check `opencode auth list` first.

## 8. Create more agents from the panel (optional)

Creating, starting, stopping, and deleting agent containers needs Docker access for the server. Review the security note at the top, then:

1. Find the Docker socket group and the Agent Host image ID:

   ```sh
   stat -c '%g' /var/run/docker.sock
   docker image inspect nimbot-agent-host --format '{{.Id}}'
   ```

2. Add to `.env`:

   ```text
   DOCKER_SOCKET_GID=<group id>
   AGENT_HOST_IMAGE=sha256:<image id>
   SERVER_CONTAINER_NAME=<server container name>
   ```

   The container name is shown by `docker compose ps --format '{{.Name}}' server` (by default `<directory>-server-1`). The image must be referenced by its immutable ID or digest; rebuilding the image gives a new ID, so update the variable afterwards.

3. Start with the override file:

   ```sh
   docker compose -f compose.yaml -f compose.docker.yaml up -d
   ```

   Use the same two `-f` options for every later Compose command. The panel now shows **Create agent**.

Agent containers run as a non-root user with all capabilities dropped, `no-new-privileges`, one CPU, 1 GiB of memory, 256 processes, no published ports, and a private network shared only with the server. Deleting an agent in the panel keeps its volumes unless you explicitly choose to delete data; deleting the Telegram bot itself is done in BotFather.

## 9. Telegram commands

| Command | Description |
|---|---|
| `/start`, `/help` | Activate the owner's chat and show help for this agent. |
| `/status` | Show whether this agent is ready, busy, or stopped. |
| `/stop` | Cancel this agent's running task. |
| Any other text | Send a task to this bot's agent. Messages queue and run one at a time. |

The agent may ask for approval before a sensitive action; answer with the **Approve** or **Deny** buttons in the same chat. No answer counts as deny.

## 10. Everyday operations

```sh
docker compose ps
docker compose logs -f server          # JSON lines with agent and task IDs; secrets are redacted
docker compose restart server
docker compose pull && docker compose build && docker compose up -d   # update after pulling new code
docker compose down                    # stops services; named volumes are kept
```

`docker compose down -v` deletes the named volumes, including workspaces and the server database. Do not use it unless you mean to.
