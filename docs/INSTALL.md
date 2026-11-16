# Installing Nimbot

Nimbot runs on one Linux server or locally on macOS with Docker Desktop. Install Docker with the Compose plugin first, start it, and ensure your user can run `docker info`. Docker Engine API 1.47 or newer is required. No Node.js, pnpm, or Git installation is needed.

## Install

Run this command in an interactive terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/celeris-it/nimbot/main/install.sh | bash
```

The installer downloads the source into `~/.local/share/nimbot`, builds both Docker images, asks for the panel URL and a password, generates private configuration, and starts Nimbot. It supports Linux and macOS and detects the local Docker socket and its group automatically. Remote Docker contexts are unsupported. Building the images requires internet access and can take several minutes.

To choose another installation directory:

```sh
curl -fsSL https://raw.githubusercontent.com/celeris-it/nimbot/main/install.sh | bash -s -- --directory "$HOME/nimbot"
```

You can download and inspect the script before running it. Only one Nimbot installation per Docker Engine is supported. Running the installer again reuses the saved source and configuration; it does not update Nimbot or reset the password. Failed installation resources are kept so you can fix the reported error and retry with the same directory.

The default panel URL is <http://localhost:3000>. On a remote server, open a tunnel from your computer:

```sh
ssh -L 3000:127.0.0.1:3000 YOUR_USER@YOUR_SERVER
```

Then open <http://localhost:3000> and sign in with your chosen password.

### Using your own HTTPS domain

If you already have a reverse proxy, enter your HTTPS origin, for example `https://nimbot.example.com`, when prompted. Configure the proxy to forward to `127.0.0.1:3000`. With Caddy:

```text
nimbot.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

The installer does not install a proxy or configure DNS. The port stays bound to loopback. Never expose the panel over plain HTTP. See the [security limitations](../README.md#security-limitations): the server's Docker access grants host-level control.

## Create your first agent

1. In Telegram, open `@BotFather`, send `/newbot`, and copy the new bot's token.
2. Sign in to the panel, choose **Create agent**, and enter its name, optional instructions, your numeric Telegram user ID, and the token. You can find your ID by messaging `@userinfobot`.
3. Wait for setup to finish. Each agent gets its own container, volumes, and bot. Incomplete or failed setup cannot execute tasks; use **Retry setup** after fixing the reported problem.
4. Authenticate the AI provider inside the agent's container. The agent ID appears in the panel:

   ```sh
   docker exec -it nimbot-<agent-id> opencode auth login
   ```

5. Open the bot link from the panel and send a task. Your first private message links the chat automatically.

Every agent needs its own BotFather bot and provider authentication. Only its owner can use it; their first private message links the chat automatically. No Telegram or per-agent environment variables are needed. Credentials stay in that agent's engine-state volume. Readiness does not verify provider access; use `opencode auth list` inside the container if tasks fail.

To replace a revoked token, open the agent's token form, enter a replacement for the same bot, and restart the server with `docker restart nimbot-server`.

## Uninstall

By default, uninstall removes Nimbot's containers and networks while keeping all volumes, credentials, `.env`, images, and source files:

```sh
bash "$HOME/.local/share/nimbot/uninstall.sh"
```

To permanently delete all agent files, conversations, provider credentials, server state, and `.env` as well:

```sh
bash "$HOME/.local/share/nimbot/uninstall.sh" --purge-data
```

The script asks for confirmation; purging also requires typing `DELETE NIMBOT DATA`. Images and source files remain. If you chose another directory, run its `uninstall.sh` or pass `--directory PATH`.

Retaining volumes is useful for backups and recovery, but does not automatically recreate removed agent containers. Review [backup and restore](OPERATIONS.md) before uninstalling if you need to recover the installation later. The installer marker is kept so you can run `--purge-data` later or retry partial cleanup. Until a stable release, installations start fresh; there are no upgrade migrations.

## Configuration and operations

The installer writes `.env` with permissions `600`. See [`.env.example`](../.env.example) for deployment settings. For a manual deployment from a clone, build both images using the Dockerfiles, generate a password hash with `docker run --rm -it nimbot-server node apps/server/dist/password.js`, and configure `.env` before running `docker compose up -d`. Manual deployments are not managed by the uninstall script.

Useful commands:

```sh
docker logs -f nimbot-server
docker restart nimbot-server
```

With a non-default Docker context, use the context selected during installation. The installer prints a logs command with the explicit socket. After rebuilding the Agent Host image, recreate the server before provisioning new agents so it resolves the new immutable image ID. From the installation directory, preserve its Compose project name:

```sh
docker compose --project-name "nimbot-$(head -n 1 .nimbot-installation)" up -d --force-recreate server
```

For backups, diagnostics, security limits, and everyday operations, see [OPERATIONS.md](OPERATIONS.md). For Telegram commands, see [README.md](../README.md#telegram-commands).

### Optional Discord connection (in development)

Open an existing agent in the panel and find **Discord notifications**. Create a
bot in the [Discord Developer Portal](https://discord.com/developers/applications),
copy its bot token, and enter it with the owner's Discord user ID. Enable
Developer Mode in Discord to copy the user ID; enter the full ID as shown.
Nimbot verifies the token before saving it privately on the server.

The panel can configure, replace, test, and remove the connection. Use **Send
Discord test** to send a fixed message to the saved owner. **Check last test
status** reuses the request without sending again. If delivery is uncertain,
check your DMs before starting another test. Five new attempts per minute per
agent are allowed. Telegram continues to receive
tasks, approvals, progress, and automatic results. Discord may restrict DMs when
the owner blocks the bot, disables direct messages, or does not share a server
with it. No Gateway connection or privileged intents are needed at this stage.

To replace a token or owner, submit both fields again. Removing the connection
keeps the agent and its Telegram connection; revoke or delete the Discord bot
separately if it is no longer needed. Remove Discord before deleting its agent.
