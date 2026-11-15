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
docker build -f infrastructure/docker/server.Dockerfile -t nimbot-server .
docker build -f infrastructure/docker/agent-host.Dockerfile -t nimbot-agent-host .
```

These commands build both images without requiring a configured `.env`. The server image is used to generate the administrator password hash in section 3, and the Agent Host image is used for panel provisioning in section 8. Run Compose only after completing section 4: it validates required runtime variables even for `docker compose build`.

## 3. Panel administrator

The panel has one administrator. Its password is stored only as a hash.

```sh
docker run --rm -it nimbot-server node apps/server/dist/password.js
```

Enter a password of at least 12 characters twice. Copy the printed `PANEL_PASSWORD_HASH=...` line. If you prefer to run it outside Docker, use `pnpm install && pnpm build && pnpm panel:password`.

## 4. Configure

```sh
cp .env.example .env
docker image inspect nimbot-agent-host --format '{{.Id}}'
stat -L -c '%g' /var/run/docker.sock 2>/dev/null || stat -L -f '%g' /var/run/docker.sock
```

The socket command supports Linux and macOS and follows symlinks to the actual socket. On macOS, Docker Desktop must be running and its default Docker socket enabled.

Edit `.env`:

| Variable | Meaning |
|---|---|
| `PANEL_PASSWORD_HASH` | Hash from section 3. |
| `PANEL_URL` | Public origin of the panel, for example `https://nimbot.example.com`. Form submissions from any other origin are rejected. |
| `AGENT_HOST_IMAGE` | Immutable Agent Host image ID printed above (`sha256:...`). |
| `DOCKER_SOCKET_GID` | Numeric Docker socket group ID printed above. |
| `TASK_TIMEOUT_SECONDS` | Maximum run time of one task, 10–3600 (default 600). |
| `SERVER_STATE_DIR` | State directory for native runs only; Compose uses a named volume. |

`DOCKER_SOCKET_PATH` and `SERVER_CONTAINER_NAME` are trusted deployment settings; the defaults use `/var/run/docker.sock` and `nimbot-server`. Only the server gets Docker access. Bot tokens, allowed Telegram users, owners, agent names, and instructions are configured in the authenticated panel. Internal Agent Host tokens are generated automatically. Do not commit `.env`.

## 5. Start and sign in

```sh
docker compose up -d
docker compose ps          # the server should become "healthy"
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

1. In the panel, open **Telegram access** and save the numeric Telegram user IDs permitted to own agents. An empty list blocks all Telegram access. Changes apply immediately without restarting the server.
2. In Telegram, open `@BotFather`, send `/newbot`, and follow the prompts. Copy the token.
3. Open **Create agent** in the panel and enter a name, optional instructions, an allowed owner's Telegram user ID, and the token. This same workflow creates the first agent and every later agent. The server checks the token and provisions its private container, volumes, network, and internal credentials.
4. The setup page shows provisioning, bot polling, and owner activation separately. Authenticate the AI provider as described in section 7. When the bot is polling, the owner opens the bot link and presses **Start**.

The server starts with zero agents; there is no bootstrap bot or pre-created Agent Host to configure.

A bot token belongs to exactly one agent. Another allowlisted user cannot use or activate an agent they do not own.

### Replacing a token

If a token is revoked or rotated in BotFather, open the agent's setup page, choose the token replacement form, and submit the new token. It must belong to the same bot. Then restart the server (`docker compose restart server`); replacement takes effect after restart. The old token is never displayed.

## 7. Authenticate the AI provider

Agents use OpenCode inside their container. Credentials are stored in that agent's own engine-state volume, so each agent is authenticated separately and credentials never pass through the server or the panel.

Every agent runs in a container named `nimbot-<agent-id>` (the ID appears in the panel and in `docker ps`):

```sh
docker exec -it nimbot-<agent-id> opencode auth login
```

Pick a provider and paste its key when asked. Readiness in the panel does not verify provider access; if tasks fail, check `opencode auth list` first.

## 8. Docker provisioning

The default Compose deployment enables provisioning for every agent, including the first. Section 4 configures its immutable Agent Host image, Docker socket group, and server container name. No override file is needed. Rebuilding the Agent Host image changes its ID: update `AGENT_HOST_IMAGE` and recreate the server with `docker compose up -d` before creating more agents.

Agent containers run as a non-root user with all capabilities dropped, `no-new-privileges`, one CPU, 1 GiB of memory, 256 processes, no published ports, and a private network shared only with the server. Deleting an agent in the panel keeps its volumes unless you explicitly choose to delete data; deleting the Telegram bot itself is done in BotFather.

### Existing installations with a pre-configured agent

If you already use the old Compose-managed agent, retain its `.env` and start with `docker compose -f compose.yaml -f compose.legacy.yaml up -d`. Use both files for subsequent operations on that installation. This preserves the legacy agent's service and named volumes while enabling panel creation for additional agents. Its environment allowlist seeds the persisted Telegram access list only once; later changes belong in the panel. Fresh installations use only `compose.yaml` and require none of those legacy variables. Do not remove volumes during this transition.

## 9. Telegram commands

| Command | Description |
|---|---|
| `/start` | Activate the owner's chat. |
| `/help` | Show help for this agent. |
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
