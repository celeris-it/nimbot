# Operating Nimbot: backup, restore, troubleshooting, and security limits

See [INSTALL.md](INSTALL.md) for installation. Commands below assume you run them in the directory that holds `compose.yaml` (`~/.local/share/nimbot` by default with the installer). For an installer-managed deployment, export its project name before using the Compose commands below:

```sh
export COMPOSE_PROJECT_NAME="nimbot-$(head -n 1 .nimbot-installation)"
```

Use the same Docker context/socket used during installation. The installer prints a logs command with its explicit socket. Do not edit or delete `.nimbot-installation`; it identifies the installation for retries and cleanup. Include it in your protected configuration backup along with `.env`.

## What holds your data

| Data | Where |
|---|---|
| Agents, owners, instructions, bot identities, chat bindings, provisioning state, task metadata | SQLite in the server state volume |
| Telegram and Discord bot tokens, and Agent Host API tokens | Private files in the same server state volume (`bot-secrets`, `discord-secrets`, `host-secrets`) |
| Agent files | Per-agent workspace volume |
| OpenCode sessions, history, and AI provider credentials | Per-agent engine-state volume |
| Task records and results | Per-agent task-state volume |

Compose stores server state in `<project>_server-state`. Every panel-created agent uses `nimbot-<agent-id>-workspace`, `-engine`, and `-tasks` volumes.

Treat backups as secrets: they contain bot tokens, Agent Host tokens, and AI provider credentials. The panel password hash and other settings live in `.env`, which is not in a volume; back it up separately and keep it private.

## Backup

Stop everything first so SQLite and the agents' files are consistent:

```sh
docker compose stop            # or: docker stop nimbot-<agent-id> for panel-created agents
mkdir -p backup
for v in $(docker volume ls -q | grep -E 'server-state|agent-workspace|agent-engine-state|agent-task-state|^nimbot-.*-(workspace|engine|tasks)$'); do
  docker run --rm -v "$v":/data:ro -v "$PWD/backup":/backup node:22-bookworm-slim \
    tar -czf "/backup/$v.tar.gz" -C /data .
done
cp .env backup/env.backup && chmod 600 backup/env.backup
if [ -f .nimbot-installation ]; then cp .nimbot-installation backup/installation.backup; fi
chmod -R go-rwx backup
docker compose start
```

Restart panel-created agent containers from the panel, or with `docker start nimbot-<agent-id>`. Copy `backup/` off the server.

## Restore

On a host where Nimbot is installed and stopped (`docker compose down`, without `-v`):

```sh
for f in backup/*.tar.gz; do
  v=$(basename "$f" .tar.gz)
  docker volume create "$v"
  docker run --rm -v "$v":/data -v "$PWD/backup":/backup:ro node:22-bookworm-slim \
    tar -xzpf "/backup/$v.tar.gz" -C /data
done
cp backup/env.backup .env
if [ -f backup/installation.backup ]; then
  cp backup/installation.backup .nimbot-installation
  export COMPOSE_PROJECT_NAME="nimbot-$(head -n 1 .nimbot-installation)"
fi
docker compose up -d
```

Extraction preserves file owners (the containers run as UID 1000). Restoring into volumes that already hold data merges files; restore into new, empty volumes unless you intend to overwrite. After startup, each registered bot reconnects with its original owner and saved chat binding.

Limits of restoring on a different host: the server state is restored. Agents created in the panel keep their volumes and registry entries, but their containers and networks do not exist on the new host, and the panel cannot yet recreate them (it can start and stop existing containers, but it has no recreate action). Prefer restoring on the same Docker host, or keep the volumes and recreate those agents. Do not delete data from the panel while recovering.

## Troubleshooting

Start with `docker compose ps`, then `docker compose logs --tail 100 server`. Logs are JSON lines with `event`, `agentId`, and `taskId`; secrets are redacted and prompts and results are never logged.

**The server exits at startup.** The log shows `server.config_invalid`, `server.state_init_failed`, or `server.docker_unavailable`. For `server.docker_unavailable`, follow its message: `permission denied` means `DOCKER_SOCKET_GID` does not match the socket's group, `socket not found` means `DOCKER_SOCKET_PATH` or the socket mount is wrong, and `not responding` means Docker is down. If `AGENT_HOST_IMAGE` is reported as not found locally, build the Agent Host image first. Check `PANEL_PASSWORD_HASH`, `AGENT_HOST_IMAGE`, Docker deployment settings, and writable server state. Telegram settings are managed through the panel and are not required for startup. A hash that was cut or reformatted is rejected; paste the whole `scrypt:...` value. Development builds before `v0.1.0` may change the database schema without migrating it: if the server cannot open an existing state volume after an update, remove that volume (`docker volume rm <project>_server-state`) and set up again.

**The panel rejects my login or forms.** Five failed logins within fifteen minutes block further attempts until the window passes. Sessions last eight hours and end when the server restarts. If sign-in works but actions fail, `PANEL_URL` does not match the address in your browser (scheme, host, and port must match); fix it and recreate the server (`docker compose up -d`).

**The bot does not answer.**

1. Open the agent's setup page. *Bot polling* shows the reason when it failed: a rejected token (replace it, then restart the server), a token that does not match the registered bot or owner, unavailable credentials, or Telegram unreachable. Telegram also refuses polling when another process uses the same token; stop the other instance.
2. The owner can send a private message to that bot; the chat is linked automatically, and the same message is processed as a task if the agent is available. No /start command is required. Only the owner (the Telegram user ID entered when the agent was created) can link and use it. Other users receive no reply, so check that the ID was typed correctly: the panel does not show it again, so if it is wrong, delete the agent and create it again.
3. Replies such as "stopped" or "not ready" mean the Agent Host is down or unhealthy: check `docker ps` and `docker logs <agent container>`.

**Tasks fail or never finish.** If every task fails, authenticate the provider (`opencode auth list`, `opencode auth login` in the agent's container); readiness does not check provider access. A task longer than `TASK_TIMEOUT_SECONDS` is stopped. After a Host restart, a task that was running is reported as interrupted; send it again. Use `/stop` to cancel a running task; queued messages behind it still run. If an approval message got no answer, the action was denied.

**Creating an agent fails.** The creation form appears only when provisioning is configured (the installer does this automatically). Typical causes: the bot token is already bound to another agent, `AGENT_HOST_IMAGE` still points at an image resolved before a rebuild (recreate the server to resolve the new ID), `SERVER_CONTAINER_NAME` is wrong, or the server cannot read the Docker socket (`DOCKER_SOCKET_GID`). The setup page shows pending, in progress, failed, interrupted, or cancelled; a failed setup keeps its resources and volumes. Interrupted work, for example after a server restart, is never retried automatically; use **Retry setup** on the agent's page. It keeps created resources and can fail until existing resources are reconciled.

**A container is reported missing or stopped.** The panel inspects Docker on each refresh. Start a stopped container from the agent's page. A missing container is never recreated silently, and its volumes stay in place.

**Browser tasks fail.** Agents drive headless Chromium through the terminal inside their own container. Confirm the container has outbound network access and enough memory (1 GiB limit).

**Unexpected state.** Resources the server did not create, or that disagree with its registry, appear as *untracked* or *missing* in the status inventory. Nimbot never adopts or deletes them automatically; inspect them with `docker ps -a --filter label=io.nimbot.agent-id`.

## Security limitations

- Nimbot is intended for trusted, self-hosted deployments. Docker containers alone do not isolate hostile multi-tenant workloads.
- Managing containers gives the server access to the Docker Engine API, which is equivalent to root on the host. A compromise of the server or panel is a compromise of the host. The fixed container template limits what the server asks Docker to do, not what an attacker controlling the server could do. Rootless Docker reduces the exposure and is recommended where practical. Without panel provisioning, the server needs no Docker access.
- Agent containers run as a non-root user with all capabilities dropped, `no-new-privileges`, CPU, memory, and process limits, no Docker socket, no server credentials, no published ports, and a private network shared only with the server. Agents cannot reach each other's API or workspace.
- Agent containers have unrestricted outbound network access, including to private addresses reachable from the host's network. Disk usage of agent volumes is not limited. Apply either restriction on the host if you need it.
- Panel access is protected by one local password, an eight-hour session, same-origin checks, and login rate limiting. Always put the panel behind HTTPS before exposing it beyond localhost.
- Telegram messages and AI provider traffic leave your server. Anything an agent is told or reads can reach those services.
- Agent actions that need your permission arrive as Approve/Deny buttons, and only a single action is granted at a time. Approve only what you recognize.

### Discord notification tests

The agent page can send a test DM to its saved Discord owner. A confirmed
rejection may mean the owner blocked the bot or does not allow DMs. Verify the
connection and Discord privacy settings before sending another test. Provider
errors are sanitized; credentials and message text are not logged.

An uncertain delivery means the provider may have accepted the message before
the response was lost. Check DMs before starting a new test. Checking the last
request returns its stored state without resending. Requests interrupted by a
server restart become uncertain and are never replayed. Notification records
and the per-agent five-attempt rolling minute limit persist in server SQLite;
automatic task results, progress, errors, and approvals use their independent path.

### Conversational channel availability

Each agent page reports Telegram polling and Discord conversation state
separately. Discord can be connecting, connected, reconnecting, failed, or
disconnected. The owner DM becomes linked after the first authorized private
message is persisted. A linked DM does not imply a live Gateway connection.

A connected channel does not prove that the container or AI provider is ready.
Check the container and Agent Host status separately. Tasks from both channels
share one FIFO and AI context; progress, results, errors, and approval prompts
return to the original channel. Discord connection failure does not stop
Telegram polling, and task services survive a Telegram polling failure.

After changing a Discord token or owner, the server replaces its Gateway
connection. A failed connection can indicate a revoked token or rejected Gateway
configuration. Save a valid connection again to reconnect; credentials and
provider error bodies are never displayed in the panel.

Gateway recovery keeps the session active during reconnects and uses Discord's
resume endpoint. Missed owner events replay before the resumed-state event;
Nimbot admits these through the same persistent deduplication checks. A replayed
message does not mean a running or completed task is executed again. Approval
interactions are restricted to the bot's owner DM, excluding group and other
private-channel contexts.
