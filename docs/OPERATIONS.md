# Operating Nimbot: backup, restore, troubleshooting, and security limits

The Server, panel and Agent Host subprocesses run in one application container.
Only the panel is published; Hosts bind to container loopback. Native development
runs the same processes without Docker. See [INSTALL.md](INSTALL.md) for setup.

This release requires a fresh installation. It does not migrate or import the
previous per-agent Docker layout. Existing installations and backups remain
untouched. Use their original release tools to recover an older interrupted
upgrade; the new `upgrade.sh` reports the unsupported operation without changes.

## Names and everyday commands

The manual install examples use container `nimbot`, volume `nimbot-data`, and
image `nimbot:local`. Use your actual names throughout this guide. The optional
installer creates `nimbot-<installation ID>` and `nimbot-<installation ID>-data`.
Its `.nimbot-installation` marker starts with `subprocess-v1`; line two is the ID,
line three the local Docker endpoint, and line four the downloaded revision.
It is metadata, not a file to execute with `source`.

For a manual installation:

```sh
container=nimbot
data_volume=nimbot-data
docker logs --tail 100 "$container"
docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container"
docker restart "$container"
```

For an installer-managed installation, first select its names and Docker Engine:

```sh
installation_dir=/absolute/path/to/installation
installation_id=$(sed -n '2p' "$installation_dir/.nimbot-installation")
container="nimbot-$installation_id"
data_volume="$container-data"
unset DOCKER_CONTEXT
export DOCKER_HOST="$(sed -n '3p' "$installation_dir/.nimbot-installation")"
```

The health check tests the panel's local login endpoint. It does not verify
Telegram, AI credentials, model access or every agent. Use the panel to inspect
Host process state, Host API readiness, bot polling and owner linking separately.
**Stop agent** and **Restart agent** require confirmation because active work may
be interrupted. Files and conversation history are kept. A failed Host needs an
explicit **Start agent**; a Server restart restores only agents whose saved
intent was running. `/stop` in a chat cancels its current task and leaves the Host
running. Deleting an agent retains its directory unless purge is selected.

The panel follows your system theme by default. Under **Settings → Appearance**,
choose **System**, **Light**, or **Dark** to save a preference in this browser.
Agents reply in the language you request or follow the conversation’s language,
with English as the fallback.

### Telegram commands

Each agent uses a distinct bot for each connected platform. The bot accepts
private messages from its configured owner. Use the web panel for agent
administration and bot token replacement.

| Command | Action |
|---|---|
| `/start` | Show an optional welcome message |
| `/help` | Show this agent's help |
| `/status` | Show chat and runtime status |
| `/schedules` | List this agent's scheduled tasks, next run times, and enabled state |
| `/stop` | Cancel only this agent's running task |
| Text message | Queue a task for this bot's agent |
| Document with a caption | Queue a task using that document |
| Document without a caption | Save the document and confirm its workspace path |

For file size limits and return files, see [Telegram documents](#telegram-documents).

## What holds your data

All Docker state lives in the single `/data` volume:

| Location | Contents |
| --- | --- |
| `server.sqlite` | Agent identity, desired process state, owner links, queues, schedules, approvals, peer grants and notes, MCP catalog and notification delivery intent |
| `bot-secrets/`, `discord-secrets/`, `host-secrets/`, `mcp-secrets/` | Private connection credentials; SQLite stores references |
| `agents/<agent ID>/workspace/` | Files, imports and exports |
| `agents/<agent ID>/tasks/` | Host task records/results, memory and ordinary-session reference |
| `ai-providers/` | Shared provider credentials, workspace-scoped OpenCode sessions, and OAuth refresh state |
| `agents/<agent ID>/engine/` | Agent-specific OpenCode configuration and cache, plus any retained pre-upgrade engine database |
| `agents/<agent ID>/browser/` | Persistent Chromium profile |
| `agents/<agent ID>/home/`, `tmp/` | Per-agent home and temporary files |

Back up the complete volume and `.env`, including retained directories of removed
agents. Backups contain secrets, private conversations and browser sessions.
The environment file supplies the administrator password hash and public panel
origin; the data volume alone does not replace it. Installer `.env` also records
`PANEL_PUBLISH_PORT` for CLI management. The Server ignores that metadata setting.

## Panel backups

Open **Settings → Backups** to create and download a `.tar.gz` copy of persistent
installation data in `SERVER_STATE_DIR`. It includes Server SQLite, agent
workspaces, conversation history, private memory, browser profiles, schedules, and saved
credentials. The archive contains secrets and private sessions and is compressed
without encryption. Keep downloaded copies private and store them off the host.

Panel exports preserve the following runtime directories and their permissions as
empty directories in the archive.

- `agents/<agent-id>/tmp/`
- `agents/<agent-id>/engine/cache/`
- `ai-providers/agents/management/tmp/`
- `ai-providers/agents/management/engine/cache/`

Runtime temporary files and engine caches are recreated as needed after recovery.
Tools may need network access to download dependencies again. Workspaces, home
directories, browser profiles, engine configuration/data/state, credentials,
databases, migration snapshots and MCP package caches remain included. The source
files stay intact during export. Manual full-volume backups below retain the
complete state tree.

Creating a backup enters maintenance, stops integrations and Hosts, waits for
outstanding writes, and closes SQLite before reading files. The HTTP panel stays
available to show progress. Active tasks may be interrupted. After validating the
archive, Nimbot reopens its services and restores the agents' saved running intent.
The download remains available for 24 hours, until the next export, or until the
Server restarts. Closing the browser after starting an export or restore lets the
operation continue on the Server.

To restore, select a panel-generated backup and choose **Validate backup**.
Nimbot checks paths, sizes, checksums, build compatibility and the Server database
before showing its date, build and expanded size. Choose **Restore this backup**
and confirm to replace the installation state. Restoration requires the same
Nimbot compilation that produced the archive. Copy the matching Docker image or
retain the source revision and build inputs when moving an installation.

Restoration pauses integrations and keeps the previous state under
`SERVER_STATE_DIR/.nimbot-backups/previous/`. It persists a recovery journal before
moving data, verifies reopening, and invalidates panel sessions on success.
Interrupted replacements are rolled back before opening databases on startup.
The next restoration replaces this recovery copy. Backup exports exclude the
reserved `.nimbot-backups` directory, including this copy and temporary files.
If recovery fails, Nimbot stays in maintenance with the panel available. Preserve
the state directory and inspect filesystem permissions, free space and Server
logs before restarting to retry recovery.

`BACKUP_MAX_BYTES` limits both uploaded archive bytes and expanded file contents
to 10 GiB by default (`10737418240`). Set a positive integer in the deployment
environment to change it. Operations also check free disk space. A restore needs
space for the uploaded archive and extracted state alongside the current state.
Creating an export also extracts a verification copy before offering a download.

The panel copy covers persistent application data. Save the host's `.env`,
installer marker, reverse proxy configuration and Docker image separately using
the full deployment procedure below. Panel restore keeps the destination's
deployment configuration and panel password.

## Backup

Use Bash for the command blocks below. Select `container` and `data_volume` as
above, then run from the directory containing the installation's `.env`.
Schedule a maintenance window: stopping the application stops the scheduler, bot
polling and Hosts, and may interrupt active tasks. Copying live SQLite files or
only agent workspaces is not a consistent installation backup.

```sh
(
  set -euo pipefail
  umask 077
  backup_dir="$PWD/.nimbot-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$PWD/.nimbot-backups"
  mkdir "$backup_dir"
  backup_image=$(docker container inspect --format '{{.Image}}' "$container")
  docker stop --time 30 "$container"
  docker run --rm --user 0:0 \
    --mount "type=volume,source=$data_volume,target=/data,readonly" \
    --entrypoint tar "$backup_image" -czf - -C /data . > "$backup_dir/data.tar.gz.tmp"
  tar -tzf "$backup_dir/data.tar.gz.tmp" > /dev/null
  mv "$backup_dir/data.tar.gz.tmp" "$backup_dir/data.tar.gz"
  cp .env "$backup_dir/env.backup"
  if [ -f .nimbot-installation ]; then cp .nimbot-installation "$backup_dir/installation.backup"; fi
  printf '%s\n' "$backup_image" > "$backup_dir/image-id"
  docker image save "$backup_image" | gzip > "$backup_dir/image.tar.gz"
  docker start "$container"
  printf 'Backup: %s\n' "$backup_dir"
)
```

The short-lived tar helper runs as root to read all archived ownership and modes;
the application still runs as non-root. The archive streams to your shell, so
its file belongs to your OS user and inherits the private backup permissions.
A failed backup leaves the application stopped; inspect the failure before
restarting it. Copy the complete backup directory off the Docker host. Keep the
matching image archive and source revision so recovery does not depend on a
mutable local image tag or rebuilding an older revision.

## Restore

This procedure restores a **subprocess-layout** backup using Docker CLI. It
cannot import old per-agent volume archives. Start with the same image that
created the backup, an unused container name, and a new volume. Keep the original
volume and backup until recovery is verified. A restore discards changes made
after that snapshot.

Stop the original application before activating its replacement, including on a
replacement Docker host. Two installations must not poll the same bot tokens or
execute the same restored queue concurrently. If the source host is unavailable,
prevent it from coming back online before starting the replacement.

On the destination, copy the backup to a private directory, choose an empty
working directory for the recovered `.env`, and run:

```sh
(
  set -euo pipefail
  umask 077
  backup_dir=/absolute/path/to/backup
  docker image load --input "$backup_dir/image.tar.gz"
  restored_image=$(cat "$backup_dir/image-id")
  docker image inspect "$restored_image" > /dev/null
  restored_volume="nimbot-restored-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  docker volume create "$restored_volume"
  docker run --rm -i --user 0:0 \
    --mount "type=volume,source=$restored_volume,target=/data" \
    --entrypoint tar "$restored_image" --numeric-owner -xzpf - -C /data < "$backup_dir/data.tar.gz"
  cp "$backup_dir/env.backup" .env
  chmod 600 .env
  panel_port=3000
  docker run -d --init --name nimbot-recovered --restart unless-stopped --stop-timeout 30 \
    --env-file .env --publish "127.0.0.1:$panel_port:3000" \
    --mount "type=volume,source=$restored_volume,target=/data" "$restored_image"
  printf 'Recovered container: nimbot-recovered\nData volume: %s\n' "$restored_volume"
)
```

Set `panel_port` to the original published port before running this block, and
use an unused container name if `nimbot-recovered` already exists. Keep `PANEL_URL`
consistent with the browser-facing origin and your existing reverse proxy.
Preserving numeric ownership lets the non-root application read the restored
private directories. Check container health, sign in, inspect agent readiness,
and check saved files, memory, provider status and schedules. Interrupted tasks
are not replayed. Running intent is restored; intentionally stopped agents stay
stopped. The recovered deployment above uses Docker CLI management, with the
printed container and volume names; the archived installer marker is retained
as provenance, not installed as a new managed installation.

For a bind mount or native development, stop the Server and every Host first,
then archive the entire configured `SERVER_STATE_DIR` and `.env` using filesystem
tools that preserve ownership and modes. Restore to a new directory writable by
the same OS account. Native development defaults to `.nimbot-native/`; never
point it at a previous per-agent-container Server database.

## Upgrade and recovery

There is no automated upgrade or import from a per-agent Docker release, and
`release.json` declares no supported predecessor (`upgradeFrom: null`).
`upgrade.sh --rollback` cannot recover the retired layout. Use its original
release's recovery procedure and keep that data separate from this release.

For a compatible revision of the subprocess application, use the Docker CLI:
build the target image before maintenance, stop and back up the complete current
installation as above, and keep its image and source. Remove only the stopped
application container, then repeat the original `docker run` command with the
target image, retained data volume and `.env`. For installer-managed deployments,
retain both ownership labels (`io.nimbot.installation=<ID>` and
`io.nimbot.layout=subprocess-v1`), the same container/volume names, environment
and published port if you want to keep using its uninstall script. Re-running
`install.sh` reuses saved source and configuration; it does not download updates.

Do not start an older image against state a newer revision may have changed.
To go back, restore the protected snapshot to a new volume using its matching
image. No automatic rollback is performed. Scheduled occurrences missed during
maintenance follow the normal lateness rules; queued work and saved task results
remain in the snapshot.

## MCP catalog and access

Under **MCP catalog** → **Examples**, choose **Set up** and save the integration. Use **Add integration** for a custom endpoint. A new integration enables all compatible tools on its first successful connection. If the server requires authentication, save a **Shared credential** on the integration’s edit page. Saving it attempts pending tool setup. For GitHub, use a personal access token. Enabled integrations are available to all current and future agents by default. Use the switch under **MCP integrations** on an agent’s **Access** page to turn it off for that agent.

If setup fails, select **Retry tool setup** from the integration. Existing integrations keep their saved tool selections. Use **Enable all tools** to opt in, then **Update tools** to add tools the provider introduces later. Updates preserve tools you disable manually. New tools use the write-or-unknown classification. Change a tool to **Read only** once you have verified that it does not make changes.

In a verified Telegram or Discord chat, the agent can search the available catalog with `list_mcp_tools` and use a tool with `call_mcp_tool`. Reads and writes run without chat confirmation by default for both new and existing integrations. Use the agent’s **Approvals** page to require confirmation or deny a specific tool. For a quick GitHub check, ask the agent to find and use the `get_me` tool.

When a result is too large for a single tool message, the agent can read the remaining parts with `read_mcp_result` during the same task. These reads use the saved result without repeating the external operation.

For a local MCP server, choose **npm (npx)** or **Python (uvx)** when adding an integration. Enter one argument per field. For npm, enter `-y` and `@modelcontextprotocol/server-everything` in separate fields. For Python, enter `mcp-server-time` in one field. Versions, npm tags, custom registries, and the launchers’ supported Git and direct package references work through the argument fields. Prefer version pins for predictable package resolution. For a Python package with a different executable name, enter `--from`, the package, and the executable in separate fields. Use **Import MCP configuration (JSONC)** to bring in a supported OpenCode MCP entry, review its settings, and save it as a Nimbot integration.

Local packages run under the installation’s OS account in a dedicated integration directory, with configuration shared by agents that have access. Use **Private environment variables** for package credentials. Nimbot stores these values in private credential files and supplies them only to the selected integration’s process. The npm and uv download caches and uv-managed Python installations live in `mcp-runtime/` under the persistent state directory. Initial startup can take up to 90 seconds. Package installation and startup run when an administrator connects or discovers a configured server.

Use **MCP catalog** to edit the HTTPS endpoint and select the allowed tools, argument schemas, and read/write classifications. Use **Other agents** on an agent’s **Access** page to manage peer grants. Changing the endpoint retires the shared credential and preserves each agent’s switch setting. If the integration used a credential, save a new one for the new endpoint. Removing a credential explicitly returns the integration to anonymous mode. The Server retries failed file cleanup on startup or a later MCP settings change. **Test connection** and **Retry tool setup** contact the saved HTTPS endpoint and automatically use the saved shared credential. The Server rejects redirects and bounds discovery to eight seconds, 256 KiB of response bodies, and four tool pages. Discovery lists tool names and object schemas. Select a tool to review its schema and access classification, then save the integration to approve it. Schemas use JSON Schema 2020-12 by default, or an explicit draft-07 declaration. Standard formats are validated. Unsupported keywords, unknown formats, unresolved references and asynchronous schemas are rejected without changing the saved definition; external references are never fetched. Schemas and tool arguments are bounded to 16 KiB and 32 nested levels. Argument validation does not convert types, insert defaults or remove extra fields.

If execution detects a missing tool, changed input schema or malformed tool listing, the Server records a tool block in `server.sqlite` and invalidates the previous catalog revision. The block survives restarts, credential changes and unrelated settings edits. **MCP catalog** marks affected definitions as **Review needed**; the agent’s **Access** page links to the tools requiring review. Use **Test connection** and **Review schema**, check the tool’s **I reviewed the schema and access** box, then **Save integration** to approve it again. Editing its schema or access clears the checkbox. A draft opened before a block must be refreshed before it can be saved. Discovery alone never clears a block, and remote tools absent from the approved catalog are never exposed. Approved tools are exposed to verified chat tasks when the integration is available to the agent. Scheduled, webhook and delegated tasks receive none. The Server connects to the administrator-selected HTTPS endpoint with the integration’s optional shared bearer credential; a missing configured credential fails without an anonymous fallback. Remote servers receive the tool name, validated arguments, MCP client negotiation/session data and the configured bearer credential. They are trusted endpoints chosen by the administrator.

To remove an integration for all agents, choose **Delete integration** in the catalog or on its edit page and confirm. This removes its approved tools, per-agent access settings, and shared credential.

When upgrading from per-agent MCP credentials, save a new **Shared credential** for each integration that previously used one. The upgrade retires the old per-agent credentials. Those integrations stay unavailable until a shared token is saved. Integrations that used anonymous connections continue to work, and agents inherit the new on-by-default access setting.

## Owner alerts and provider status

When upgrading an existing subprocess installation, Nimbot moves OpenCode conversations into the shared database. A provider with one saved credential or matching credentials is carried forward. If active credentials differ, **AI providers** shows **Reconnect required**. Connect that provider once for the installation. Original engine databases are retained in agent directories for recovery and may still contain old credentials. Include the entire state tree in backups.

The agent's page shows **AI provider status** and the time of the last check.
When a saved API key is rejected or OpenCode reports that a ChatGPT or Console
connection needs reauthentication, open **AI providers** to replace
the key or sign in again. Saving a key requires a successful provider check.
If the provider is unavailable, denies access, or rate limits the check, the
previous credential stays active. An OAuth connection without a conclusive
sign-in signal appears as **Unverified**. The checks use no inference quota.
API key checks run at startup, every five minutes, and after credential changes.

Open **Schedules** to investigate three consecutive execution failures.
A successful execution resets the streak. Timed, manual and webhook runs share
the same streak. Skips, cancellations and interruptions leave it unchanged.

Check the process status and application logs after an unexpected Host exit.
The Server checks process observations every 30 seconds, suppresses deliberate
stops and clears the incident after a successful start.

Alerts go through the agent's own bot to the linked private Telegram chat. With
the bot unavailable, an alert waits while the incident remains open. Nimbot
persists delivery intent across Server restarts. Uncertain deliveries are never
replayed. Telegram delivery requires the Nimbot Server to be running.

## Troubleshooting

- **Application unhealthy:** inspect `docker logs --tail 100 "$container"`. Check
  the panel password hash, `PANEL_URL`, the data mount and available disk space.
  The image expects `/data` writable by UID 1000. Do not replace it with an empty
  volume to hide a startup failure; preserve the original and diagnose it.
- **Fresh installation required:** a previous Server schema was detected. Choose
  a new data directory or volume. The rejected database is left unchanged; no
  migration or import is provided.
- **Host failed:** inspect the agent's process state, its persistent directories
  and application logs, then use **Start agent**. A missing or corrupt saved Host
  credential requires repair or restoration; it is not silently rotated.
- **Bot unavailable:** verify its owner and bot identity, token and connectivity.
  Replace a revoked token with one for the same BotFather bot, then restart that
  agent. Check that another installation is not polling the same bot.
- **Owner chat pending:** the configured owner must send a private message to the
  agent's own bot. Telegram group chats and other owners cannot activate it.
- **Provider unavailable:** open **AI providers** in the sidebar to update the
  shared connection. Failed or cancelled attempts keep the previous credential.
  Check **AI provider status** for credential health and **Model and usage**
  for model availability and quota.
- **Maintenance lock exists:** installer commands serialize through the
  `.nimbot-maintenance` symlink. Confirm that the maintenance process has exited
  before removing a stale lock. Do not remove a live command's lock.

### Telegram documents

The owner's private bot chat accepts one Telegram document per message, up to
10 MiB. A caption runs a task. A document without a caption is saved without
using the AI provider. Both use the agent's FIFO queue. Reply to the original
message to use a saved document, or pass its workspace path in a new task.
Nimbot accepts all document types. The agent's tools determine which formats
it can read. Send a photo as a document if you want to save the original file.

The Server stores the Telegram file reference before downloading. The Agent
Host stores the file in `attachments/<task-id>/` within its workspace.
A queued import can resume after a restart. An interrupted import or task
is not replayed. After a failed import, resend the original document.

To receive a file, ask in the chat. The agent can select one file of up to
10 MiB from that turn's `exports/<task-id>/` directory. Nimbot sends it back
to the originating chat after successful completion. The selected copy is
held in memory for up to ten minutes. If delivery is uncertain, check the chat
before asking again. Imported and exported workspace files are retained with
the workspace directory and included in its backups.

### Discord attachments

In the linked owner DM, send one file of up to 10 MiB. Text in the same
message runs a task using the file. A file sent by itself is saved to
`attachments/<task-id>/` without using the AI provider. Reply directly to the
original message or use the confirmed workspace path in a later task.

Queued imports can resume after a Server restart. The Server fetches the
original Discord message when the task runs, so leave the original attachment
available until Nimbot saves it. If the import fails, resend the file.

Ask the agent in the DM to return a file. After a successful chat task, it can
send one file of up to 10 MiB from that task's exports directory. Check the DM
before asking again if delivery is uncertain.

### Model and usage

Use **AI providers** in the sidebar to connect an OpenCode Console workspace
with Console budgets or a Go subscription. The saved connection is shared by the
installation. Configure spending policies in OpenCode Console.

Open **Model and usage** from an agent's setup page. Choose an enabled model or
**Automatic** to use OpenCode's current default. The selection applies when the
next task starts and uses the same conversation. When the selected model offers
variants, choose a **Reasoning effort** or leave it at **Default**. Changing
models resets the effort. If a saved model or effort becomes unavailable, the
queue waits for it to return or for the administrator to change the selection.

Usage shows tokens and OpenCode's reported USD cost for each executed task, with
agent totals for the UTC day and month. The figures reflect the engine's
available observations, including when a task fails or is cancelled. Partial
readings and missing costs are shown in the panel. Provider invoices and
subscription fees can differ from these figures.

For a connected OpenCode Console workspace, the applicable monthly Console
budgets and the Go rolling, weekly, and monthly allowances come from OpenCode.
An exhausted applicable limit or a temporary error checking a covered quota
pauses new work. Chat, scheduled, and webhook tasks keep their normal enqueue
rules and resume in order after OpenCode confirms that work can continue.
For a direct OpenAI model connected through ChatGPT device login, the panel
shows the account's reported usage windows and reset times. This read uses
ChatGPT's internal usage endpoint and is informational. Console and Go limits
apply at the start of a task. Quota readings reflect snapshots of possibly
shared accounts. When quota data is unavailable for other connections or the
ChatGPT read fails, the panel shows **Quota unavailable** and tasks can proceed.

While the queue is paused, the Server checks applicable limits every 30 seconds.
If a check fails, verify the workspace login and network connectivity. A stopped
Agent Host still needs to be started from the panel. Usage is attributed to the
UTC day and month when the task started. Work outside Nimbot can also use the
shared quota, and a check can allow a task to start just before the limit is reached.

### Scheduled tasks

Open **Schedules** on the agent page for the last run outcome, execution
status, and recent history. The owner can use `/schedules` to check next run times
enabled state, and delivery channels in Telegram or Discord without contacting the
Host. Choose **Delivery channel** when creating or editing a schedule in the panel.
A schedule confirmed in chat delivers to that chat. The server checks schedules at
startup and every 30 seconds, so admission is not guaranteed at the exact second
shown in the panel. Once enqueued, a task can also wait behind earlier work in the
agent's FIFO queue.

**Skipped: agent unavailable or owner chat unlinked.** Check that the Host process is
running and its API is reachable, and the owner's private
chat on the selected channel is linked. The owner must send that bot a private
message to link it. Nimbot never starts a stopped
Host for a schedule. Only the first not-ready skip of a consecutive streak
attempts a notice through durable notifications; a missing owner chat, unavailable
bot, or notification quota can prevent that notice. Further skips remain visible
in history.

**Skipped: previous run still queued or running.** The same schedule already has
unfinished work. Let it finish, inspect queue and bot availability, or increase
the interval. `/stop` cancels only the owner's running task; it does not remove
queued work. A different schedule or chat task for the same agent shares that
queue and may delay execution.

**Webhook requests.** A webhook schedule runs on `POST /hooks/schedules/:id` with
its Bearer token; `/schedules` shows it as "Runs on webhook request". Responses
identify the cause:

| Status | Cause and action |
| --- | --- |
| `401` | Missing, wrong, or regenerated token, an unknown schedule, or one no longer using webhook activation. Copy the current token from **Show webhook details**. |
| `409` | The schedule is paused, changed during the request, or the agent is unavailable or its owner chat is unlinked. Nothing was queued; fix the cause and send the request again. |
| `413` / `415` / `400` | The body exceeds 16 KiB, is not `application/json`, or is not valid JSON. |
| `429` | More than five attempts in a minute, or 20 unfinished tasks already queued for this schedule. Wait for `Retry-After` or for the backlog to drain. |
| `503` | The server is shutting down. |

Requests received while an earlier run is unfinished are queued, not skipped, so
a slow agent accumulates a backlog; check the schedule's recent runs for queued
entries. The token is stored in `server.sqlite` and is part of every backup.

**Missed: more than 10 minutes late.** Check server downtime and clock accuracy.
Missed occurrences are not replayed. When the agent is ready, **Run now** can
request a manual run without changing the next scheduled time and uses AI
provider credits as usual. A once schedule is disabled after handling its due
occurrence even if it was skipped or missed; edit its date before resuming it.

**Enqueued but no result.** Check the associated task's status and Telegram polling
before submitting again. Scheduled runs send only a named final result or failure,
without working updates. Approvals still require the owner; the Host denies an
unanswered request after its existing timeout. Provider authentication, credits,
and task timeout troubleshooting are the same as for chat tasks.

Logs use `schedule.fired` and `schedule.skipped` with `agentId`, `scheduleId`, and
`outcome`, or `schedule.failed` and `schedule.tick_failed` when processing fails.
Prompts are never logged. The latest 20 runs per schedule are retained; deleting
a schedule or agent removes that schedule history, while already queued task
metadata is retained.

Keep the Docker host's clock synchronized. Due instants are stored as UTC
milliseconds and evaluated against the server clock. Each calendar schedule uses
its own IANA time zone; changing the browser or server's local time zone does not
change an existing schedule. The browser's zone is only the form's initial
default. A skipped daylight-saving local time moves to the next valid instant;
a repeated local time uses its first occurrence only. Intervals use elapsed
minutes anchored to creation time. See [Scheduled tasks](SCHEDULES.md)
for cadence rules and limits.

## Security limitations

One installation is a single trust domain under one OS account. Agents can read
or modify each other's workspaces, memory and provider credentials, and can
access Server state including bot tokens, MCP credentials, Host secrets and
`server.sqlite`. A prompt-injected agent could read Server secrets or change
Server state. Approvals, grants and rules govern normal behavior; they are not a
security boundary against an agent with shell access. Use separate installations
when separation is needed.

The application runs as non-root in one container without a Docker socket. Only
the panel is published, on host loopback by default. Each Host has a private API
token, a loopback listener and a minimal environment. These measures reduce
accidental exposure; they do not isolate agents from each other or the Server.
Outbound networking is unrestricted, including private addresses reachable from
the installation. Per-agent resource-limit configuration is deferred. Use an
existing HTTPS proxy for remote panel access, keep `.env` and backups private,
and never mount the Docker socket into the application.

Disk usage is uncapped. Bot credentials stay in the Server and are kept out of
model context, task events, and normal logs. Panel passwords use scrypt. Sessions
expire after eight hours or on Server restart. Cookies use HttpOnly and SameSite,
with Secure cookies for HTTPS. State changes require the configured same origin.
Messages and provider requests are sent to their respective external services.

## Discord notification tests

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

The authenticated test API accepts a request ID and sends a fixed message to the
saved owner. Request IDs deduplicate repeated submissions. The quota counts new
attempts across channels, including provider rate-limit responses. Locally blocked
requests leave the window unchanged. Nimbot stores a content hash and sanitized
delivery state, and refreshes its resolved recipient when configuration changes.
The Discord adapter splits long text, suppresses mentions, and honors rate-limit
cooldowns. Remove the Discord connection from **Channels** before deleting the agent.

## Conversational channel availability

Each agent page reports Telegram polling and Discord conversation state
separately. Discord can be connecting, connected, reconnecting, failed, or
disconnected. The owner DM becomes linked after the first authorized private
message is persisted. A linked DM does not imply a live Gateway connection.

A connected channel does not prove that the Host process or AI provider is ready.
Check process state and authenticated Agent Host readiness separately. Tasks from both channels
share one FIFO and AI context. During a direct chat request, the bot shows the
channel's native typing indicator while the model runs. Results, errors, and
approval prompts return to the original channel. Discord connection failure does not stop
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

On server startup, a restored Telegram task remains queued until its verified
reply bot is attached. The queue keeps FIFO order, so later tasks wait behind
that task rather than executing it without a return route. Discord tasks at the
head of the queue can run without a Telegram connection. A failed Telegram
identity check leaves its saved work queued; restore a valid token and restart
the server before expecting that work to resume.
