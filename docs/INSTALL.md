# Installing Nimbot

Nimbot runs the Server, panel and Agent Host subprocesses in one non-root Docker
container. Docker Compose and a Docker socket mount are not required. Native
development is documented in [README.md](../README.md#development).

## Fresh installation requirement

This subprocess release requires a new data volume. It does not migrate or import
previous per-agent container installations. Existing databases are rejected and
old containers, volumes and files remain until you explicitly remove them.
The optional installer uses the same Docker CLI layout. The previous automatic
upgrade and per-agent-volume recovery scripts are retired.

## Optional assisted installation

Docker Engine or Docker Desktop must already be running. On Linux and macOS,
run this in an interactive terminal (you can download and inspect it first):

```sh
curl -fsSL https://raw.githubusercontent.com/celeris-it/nimbot/main/install.sh | bash
```

The script downloads source, builds one application image, asks for the panel
port, origin and password, creates one named data volume, and starts one
application container. It does not use Compose or mount the Docker socket.
Password input is hidden and travels only over stdin to the hash helper.
Configuration is saved in a private `.env`; its additional `PANEL_PUBLISH_PORT`
setting is installer metadata, not a Server bind setting.

Use `--directory /absolute/path` to choose an empty destination, and optionally
`--version vX.Y.Z` for an initial release tag that includes this layout:

```sh
curl -fsSL https://raw.githubusercontent.com/celeris-it/nimbot/main/install.sh | bash -s -- --directory "$HOME/nimbot"
```

The default destination is `~/.local/share/nimbot`. Previous installation markers
are rejected without deleting data. Re-running with the same directory reuses
source, password and retained data; it does not download updates. Local Unix
Docker contexts are supported. Containers and volumes are named using a generated
installation ID so separate installations can coexist with different panel ports.
The marker's first line is `subprocess-v1`; never execute its contents as shell.

After a failed installation, fix the reported error and retry the same command.
Resources and configuration are retained. The script waits for application health;
agent and provider readiness are checked separately in the panel.

## Install with Docker CLI

Use Docker Engine on Linux or Docker Desktop on macOS. Start from a checkout of
the desired Nimbot revision. Node.js, pnpm, OpenCode and Chromium are installed
inside the image; they are not prerequisites on the Docker host.

```sh
docker build -f infrastructure/docker/nimbot.Dockerfile -t nimbot:local .
docker run --rm -it --entrypoint node nimbot:local apps/server/dist/password.js
```

The second command prompts for the administrator password and prints a
`PANEL_PASSWORD_HASH=...` line. Put that line in a private `.env` file beside the
checkout, followed by:

```dotenv
PANEL_URL=http://localhost:3000
TASK_TIMEOUT_SECONDS=600
```

Run `chmod 600 .env`. Do not put a plaintext password in this file or commit it.
Create a new named volume and start the application:

```sh
docker volume create nimbot-data
docker run -d --init --name nimbot --restart unless-stopped --stop-timeout 30 \
  --env-file .env -p 127.0.0.1:3000:3000 \
  --mount type=volume,source=nimbot-data,target=/data nimbot:local
```

Open `http://localhost:3000`. The installation starts with zero agents. Only the
panel is published. Agent Hosts and OpenCode APIs bind to container loopback;
each Host has its own API token. The complete application runs as `node` (UID
1000). All persistent state lives under `/data`, including Server SQLite, bot and
MCP credentials, agent workspaces, task state, provider state and browser profiles.
Docker initializes a new named volume from the image's writable data directory.
If you choose a bind mount, ensure it is writable by UID 1000 before starting.

Use a different container name, volume name and published port for a separate
installation. Never share the data volume between running installations.
Do not override `SERVER_STATE_DIR` or `PANEL_HOST` with native development values
in the container; the image defaults are `/data` and `0.0.0.0` respectively.

### Using your own HTTPS domain

Keep the Docker port bound to host loopback. Configure an existing reverse proxy
with TLS, point it at `http://127.0.0.1:3000`, and set `PANEL_URL` to the exact
HTTPS origin (no path). Recreate the application container after changing `.env`.
Remote access requires HTTPS. Proxy provisioning is outside Nimbot's scope.

## Trust model

One installation is a single trust domain under one OS account. Agents can read
or modify each other's files, memory and provider credentials, and can access
Server state including bot tokens, MCP credentials, Host secrets and
`server.sqlite`. A prompt-injected agent could read Server secrets or change
Server state. Approvals, grants and rules guide normal behavior; they are not a
security boundary against an agent with shell access. Use separate installations
when separation is required. Never mount the Docker socket into the application.

## Create your first agent

1. Sign in to the panel, choose **Create agent**, and enter its name and optional instructions.
2. Wait for its Agent Host to start. If startup fails, choose **Start agent** on **Overview**.
3. Open **Channels** and connect either or both messaging platforms.
   - **Telegram:** Use `/newbot` in `@BotFather` to create a bot. Under **Telegram connection**, enter your numeric Telegram user ID and the bot token, then choose **Connect Telegram**.
   - **Discord:** Create a bot in the Discord Developer Portal. Copy your user ID with Discord Developer Mode enabled. Under **Discord connection**, enter that ID and the bot token, then choose **Connect Discord**.
4. Choose **AI providers** in the sidebar. You can connect providers before creating an agent. Save an API key for OpenAI, Anthropic, Google, or OpenRouter. For OpenAI, you can instead choose **Sign in with ChatGPT**, open the displayed OpenAI link, and enter the device code there. Enable device code login in your ChatGPT account security settings or workspace permissions if required. To connect a Console workspace for Console budgets or the Go allowance, choose **Sign in to OpenCode Console** and complete authorization using the displayed link and code. Wait for the panel to confirm completion. The panel shows connection status after saving. All agents share the saved connections.
5. In **Model and usage**, choose an enabled model or leave **Automatic** to use OpenCode's default.
6. Send the connected bot a task in a private message from the configured owner account. The first message links the owner chat automatically.

Each messaging connection uses a distinct bot and accepts private messages from its configured owner. OpenCode stores shared provider credentials in the installation’s `ai-providers/` directory and renews OAuth tokens there. Change the selected model from each agent’s **Model and usage** page.

You can cancel device login from the panel. Failed, cancelled, or timed-out attempts keep the previous credential. Device login has a ten-minute limit. Restarting Nimbot interrupts a pending login. Refreshing the browser recovers an attempt that is still running. After a credential change, the next agent turn uses the updated connection.

To replace a revoked token, open the agent's token form, enter a replacement for the same bot, and choose **Restart agent** in the panel.

## Upgrade

There is no upgrade or import path from the previous per-agent container release.
For another revision of this subprocess installation, stop the application and
back up its entire data volume first. Build the target image, remove only the
stopped application container, and run the same Docker command with the retained
volume and `.env`. Active tasks can be interrupted during the maintenance window.
See [upgrade and recovery](OPERATIONS.md#upgrade-and-recovery) for the manual
procedure. `upgrade.sh` reports unsupported automatic upgrades without changing
resources. Keep the previous image and a complete backup before replacing it.

## Uninstall

For an installer-managed deployment, use its saved script:

```sh
bash /absolute/path/to/installation/uninstall.sh
```

It asks for confirmation and retains the data volume and `.env`. Add
`--purge-data` only to permanently erase them; this requires a second typed
confirmation. Images, source, backups and the installation marker remain. The
script inspects only its exact application and data-volume names and refuses
foreign ownership labels. Rerun the installer with the same directory to resume
retained data.

For a manual deployment, stop and remove the application while retaining data:

```sh
docker stop nimbot
docker rm nimbot
```

The `nimbot-data` named volume, source checkout, image and `.env` remain.
Only when you explicitly want to erase all installation data, remove the volume:

```sh
docker volume rm nimbot-data
```

This permanently deletes Server state, agents, files, histories, provider
credentials and browser profiles. Back up what you need first. Removing an agent
from the panel retains its own data unless you select the explicit purge option.

## Configuration and operations

`docker logs -f nimbot` shows application logs. `docker restart nimbot` stops the
Server and its Hosts, then restores agents whose desired state was running.
For panel lifecycle actions, use **Start agent**, **Stop agent** or **Restart
agent**. `/stop` in a chat cancels only that agent's current task.
See [OPERATIONS.md](OPERATIONS.md) for complete-volume backups, recovery,
troubleshooting and the shared trust model. Old per-agent-container and Compose
recovery procedures do not apply.

### Optional Discord connection

Open an existing agent in the panel and find **Discord connection**. Create a
bot in the [Discord Developer Portal](https://discord.com/developers/applications),
copy its bot token, and enter it with the owner's Discord user ID. Enable
Developer Mode in Discord to copy the user ID; enter the full ID as shown.
Nimbot verifies the token before saving it privately on the server.

The panel can configure, replace, test, and remove the connection. Use **Send
Discord test** to send a fixed message to the saved owner. **Check last test
status** reuses the request without sending again. If delivery is uncertain,
check your DMs before starting another test. Five new attempts per minute per
agent are allowed. Private text messages on either configured bot enter the
agent's shared queue. Progress, approvals, and results return to the channel that
received the task. Use `/stop` in the Discord owner DM to cancel its active task. Discord may restrict DMs when
the owner blocks the bot, disables direct messages, or does not share a server
with it. The server now opens a Gateway connection using the direct-message intent;
privileged intents are not required. Discord conversations use the shared agent
task runner.

To replace a token or owner, submit both fields again. Removing the connection
keeps the agent and its Telegram connection; revoke or delete the Discord bot
separately if it is no longer needed. Remove Discord before deleting its agent.
