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
| Schedules, saved prompts, cadences, time zones, next-run timestamps, private webhook tokens, and the latest 20 run records per schedule | `server.sqlite` in the same server state volume |
| Telegram and Discord bot tokens, and Agent Host API tokens | Private files in the same server state volume (`bot-secrets`, `discord-secrets`, `host-secrets`) |
| Agent files | Per-agent workspace volume |
| OpenCode sessions, history, and provider credentials | Per-agent engine-state volume |
| Task records and results, tool request outbox, and saved tool outcomes | Per-agent task-state volume |
| Delegation handoffs and bounded child outcomes (`delegations`) | `server.sqlite` in the server state volume; included in Server backups |
| Peer note inboxes (`agent_notes`) | `server.sqlite` in the server state volume; included in Server backups |
| External MCP definitions and per-agent grants | `server.sqlite` in the server state volume |
| External MCP bearer credentials | Private files under `mcp-secrets` in the server state volume |
| Agent memory notes (`memory.sqlite`) | Per-agent task-state volume; included in backups of it, and removed only when the volume is explicitly purged |

Compose stores server state in `<project>_server-state`. Every panel-created agent uses `nimbot-<agent-id>-workspace`, `-engine`, and `-tasks` volumes.

Server backups contain bot tokens, Agent Host tokens, and MCP bearer credentials. Agent backups can contain AI provider credentials. Keep the backups private, and back up the panel password hash and other `.env` settings separately.

## Backup

Stop everything first so SQLite and the agents' files are consistent.

Schedules and their history are included in the server-state backup; there is no
separate scheduler volume or configuration file. Stop the server as well as agent
containers: the scheduler remains active when only agent containers are stopped
and continues writing skipped-run records.

```sh
docker compose stop            # also stop panel-created agents: docker stop nimbot-<agent-id>
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

Schedules and run history return with the server database. The scheduler considers
each saved due occurrence once: up to 10 minutes late can still run if admissible;
older occurrences become missed. It advances past the current time instead of
replaying a backlog. Queued work remains in the ordinary task queue; interrupted
running tasks are not replayed automatically.

Limits of restoring on a different host: the server state is restored. Agents created in the panel keep their volumes and registry entries, but their containers and networks do not exist on the new host, and the panel cannot yet recreate them (it can start and stop existing containers, but it has no recreate action). Prefer restoring on the same Docker host, or keep the volumes and recreate those agents. Do not delete data from the panel while recovering.

## Troubleshooting

Start with `docker compose ps`, then `docker compose logs --tail 100 server`. Logs are JSON lines with `event`, `agentId`, and `taskId`; secrets are redacted and prompts and results are never logged.

**The server exits at startup.** The log shows `server.config_invalid`, `server.state_init_failed`, or `server.docker_unavailable`. For `server.docker_unavailable`, follow its message: `permission denied` means `DOCKER_SOCKET_GID` does not match the socket's group, `socket not found` means `DOCKER_SOCKET_PATH` or the socket mount is wrong, and `not responding` means Docker is down. If `AGENT_HOST_IMAGE` is reported as not found locally, build the Agent Host image first. Check `PANEL_PASSWORD_HASH`, `AGENT_HOST_IMAGE`, Docker deployment settings, and writable server state. Telegram settings are managed through the panel and are not required for startup. A hash that was cut or reformatted is rejected; paste the whole `scrypt:...` value. Pre-stable releases initialize the current schema directly and do not migrate older databases or persisted state. If an update cannot open an older state volume, keep a protected backup and prepare a fresh installation. Restoring an older schema does not upgrade it; do not delete the existing volume without explicitly choosing to discard that state.

**The panel rejects my login or forms.** Five failed logins within fifteen minutes block further attempts until the window passes. Sessions last eight hours and end when the server restarts. If sign-in works but actions fail, `PANEL_URL` does not match the address in your browser (scheme, host, and port must match); fix it and recreate the server (`docker compose up -d`).

**The bot does not answer.**

1. Open the agent's setup page. *Bot polling* shows the reason when it failed: a rejected token (replace it, then restart the server), a token that does not match the registered bot or owner, unavailable credentials, or Telegram unreachable. Telegram also refuses polling when another process uses the same token; stop the other instance.
2. The owner can send a private message to that bot; the chat is linked automatically, and the same message is processed as a task if the agent is available. No /start command is required. Only the owner (the Telegram user ID entered when the agent was created) can link and use it. Other users receive no reply, so check that the ID was typed correctly: the panel does not show it again, so if it is wrong, delete the agent and create it again.
3. Replies such as "stopped" or "not ready" mean the Agent Host is down or unhealthy: check `docker ps` and `docker logs <agent container>`.

**Tasks fail or never finish.** If every task fails, open **Configure AI providers** on that agent's setup page. Start its container and wait for any task to finish before replacing the API key or using OpenAI's ChatGPT device login. Credentials and login methods are independent per agent. Saving credentials and Host readiness do not verify provider validity, balance, or model access. OpenCode refreshes OAuth tokens inside the agent. Device login rejects new tasks as busy until it finishes; resend them afterwards. Cancel a pending login from the panel, or restart it after a Host restart or the ten-minute local deadline. Failed or cancelled login keeps the previous credential. Disconnecting only removes the local credential; revoke it at the provider separately if needed. A task longer than `TASK_TIMEOUT_SECONDS` is stopped. After a Host restart, a task that was running is reported as interrupted; send it again. Use `/stop` to cancel a running task; queued messages behind it still run. If an approval message got no answer, the action was denied.

The Server task database retains the accepted Host task ID, and the Host task database retains the corresponding Server task ID and agent ID. These associations survive restart and help correlate uncertain work. If saving the accepted Host ID fails, the Server requests cancellation, reports the task as unavailable, and never resubmits it automatically. Cancellation is best effort: the Host may already have completed work. Correlation fields do not authorize application tools. The Host also records a Server-selected `sessionMode: "fresh"` for an isolated turn: it starts a new OpenCode conversation without reading or updating the saved owner session file. Ordinary chat afterward resumes the existing owner conversation. This mode stays outside the prompt and does not grant tools; the Server now selects it for persisted delegated children, while ordinary turns retain their owner conversation.

Tool capabilities are internal to the application-tool bridge. Production services issue memory operations only for chat tasks of agents whose memory switch is enabled; it is off by default. Directed peer grants additionally enable discovery, sending notes, reading a recipient inbox and delegation handoffs for authorized chat tasks. No peer grants means no peer tools. External MCP handlers are still in development. When a Server policy grants specific operations, its token exists only for the task lifetime (up to one hour). The Host holds it in memory, outside the prompt and task/event database. The Server retains only its hash in memory and checks persisted task state, current grants and conversation authorization on each guarded call. Cancellation and service shutdown revoke immediately; execution ending revokes before queue finalization, even if saving the terminal task status fails. Restarts cannot restore a capability from backups. Scheduled tasks and webhook tasks are excluded regardless of their prompt or payload.

The bundled MCP adapter opens only on loopback inside the agent container, with a separate credential for each turn. It registers only granted handlers and closes when the prompt ends or the engine stops, including when stopping during startup. Its request and response limit is 64 KiB, with four concurrent calls and 100 calls per turn. Calls time out after at most 60 seconds or the capability deadline, whichever comes first. MCP cancellation and turn termination abort their signals. Service handlers must validate arguments and honor cancellation; aborting a call does not undo an already completed side effect. The adapter never supplies the Host API credential to tools. Private memory handlers run inside the Host. Privileged operations use the Server dispatcher, which rechecks the capability against persisted Server state and validates arguments in the receiving service; production privileged handlers will be added with their features.

The Host saves Server-bound tool requests and their bounded arguments in `tool_requests` together with the corresponding task event. It saves an immutable outcome before resolving the caller. Repeated identical replies can be acknowledged while that turn is active; changed replies and late successes are rejected. A result committed before cancellation remains available in the database for review, even when the cancelled caller receives no success. Pending requests become interrupted on Host restart and are never republished automatically. The authenticated liveness endpoint reports only active in-memory waiters, so restored records cannot claim to be awaiting execution. The outbox contains no framework-supplied capability or Host API token, but request arguments and results remain private task data included in task-volume backups. The Server dispatcher independently validates authority and persists its own write intent and outcome in `server.sqlite`; these Host records cannot provide that guarantee. Identical task-scoped invocation IDs replay the saved outcome; changed arguments are rejected. A write whose outcome could not be saved stays uncertain and is never automatically repeated, including after restart. Server cancellation aborts active tool calls immediately and rejects new tool events without waiting for the Host to confirm cancellation. The dispatcher stops waiting even if a handler ignores abort, closes its handler scope on every exit, and suppresses late results.

For delegation, `agent_delegate` asks the initiating owner for approval with a 30-second deadline, then stores an explicit brief of at most 2,000 characters and returns its pending ID without waiting for the child. Only three handoffs are allowed per parent, with durable invocation replay protection; changed arguments cannot reuse an invocation. The Server checks grants and the saved origin before staging and again in the parent completion transaction. Failure, accepted cancellation or revoked authorization discards pending handoffs. The child receives only the brief. As part of this coordination, admitted children are durable before worker activation, and startup reconciles the commit-before-activation window without resubmitting the parent. Failed target credential loading leaves children queued for a later resume. Running work interrupted by recovery is never replayed. An accepted parent cancellation prevents a pending handoff even if a late Host response completes the parent. Child results now persist in the same transaction as terminal state, capped at 8,192 serialized UTF-8 bytes including JSON escapes; truncated output is marked. Completed results are immutable and survive restart, while interrupted children receive a terminal interrupted result without rerunning work. Failed result storage rolls back completion and prevents outcome publication. These outputs are private, untrusted task data included in Server backups. Chat tasks with outgoing delegation grants can use `agent_delegation_status` to retrieve only their own handoffs and bounded results. Each call rechecks the live target grant under both the current channel and saved parent channel, plus the saved parent conversation binding; another live grant cannot restore access to a revoked target. Pending handoffs do not advance until their parent turn ends, so check from a later turn. The response omits the parent prompt and delegation brief and labels results as untrusted data. Native OpenCode child permissions now have a relay handler through the saved parent bot. It checks the admitted child and accepted Host task ID, rechecks the grant and origin before accepting a callback, and sends a single decision to that exact child Host. Model permission titles never match structured approval rules. Pending permissions expire within ten minutes, and cancellation, turn completion or either service closing denies them. Duplicate events and uncertain decision replies never cause another question or decision during that turn. A stale binding rejects callbacks; any unresolved question then expires without allowing execution. Original-conversation outcome delivery is now prepared through the source service: it reads the committed bounded result and verifies the handoff, saved source conversation and current target grant. The source bot sends plain, labeled untrusted output only to that conversation, checking authorization before each Telegram or Discord message part; Discord disables mentions. The existing notification store records an intent before sending and applies its five-per-minute per-agent budget. Delivered, partial, failed and uncertain sends are never retried automatically, including after restart. A later source task can still read the result through the status tool when authorized. Notification history stores the content hash and outcome, not an additional copy of the result. Children now execute in the target FIFO after rechecking the persisted handoff, saved parent conversation and exact grant. Target admission uses the existing linked Telegram bot, owner chat and provisioning readiness checks; a failed check records `not_ready` without contacting the Host. A stopped Host follows the existing bounded unavailable/error path. Failed credential loading before the target service starts still leaves work queued. The Host receives the explicit source brief, its own configured agent instructions and Server-selected `sessionMode: "fresh"`; no source transcript or application-tool capabilities are passed. The source can accept unrelated work while a child is queued or running. Child permissions use the original source bot, and committed results use the outcome relay described above. Startup now discovers terminal outcomes without notification intents, including interrupted results recorded by recovery, and attempts authorized delivery through the original source service. Source-scoped scans read at most 100 handoff IDs per page and skip existing intents before reading result bodies. They never resume a source task queue. An unattached Telegram bot leaves no intent; attaching it scans again after any earlier scan finishes. If source credentials cannot load, the persisted result remains available for a later startup or resume. Current grants and the saved origin are checked again before sending; the normal notification budget still applies. Existing intents, including failed or uncertain sends, are never retried. The task service supports exact-child cancellation. Queued cancellation commits the terminal result without stopping the current FIFO head. Running cancellation first persists its request, then aborts only that child; permission relays reject further decisions, and finalization or restart recovery records cancellation instead of a late success. The status tool reports `cancellationRequested` while the child is still returning. As with ordinary cancellation, work already performed cannot be undone. Queued children remain queued during pending container actions and after a recorded completed/interrupted stop, even if the task service is resumed directly. Starting the agent through the panel kicks its FIFO again. Startup and successful deletion also reconcile targets: if the registry no longer contains the destination, only correlated queued delegated children receive a terminal `not_ready` result, without loading target credentials. Ordinary queued tasks, running work and saved terminal results are left unchanged. Target existence is rechecked after credential loading; transient credential failures keep children queued. Unobserved Host outages still use the existing bounded unavailable/error path. Result delivery continues to require a live grant and saved origin, so deletion does not bypass revocation. Panel APIs now provide source-scoped history at `GET /api/agents/:id/delegations` (20 entries per page, with `page` pagination) and cancellation at `POST /api/agents/:id/delegations/:delegationId/cancel`. They require the existing panel session and same-Origin mutation checks. History returns bounded brief previews, state and cancellation eligibility, omitting conversation prompts and child outputs. Cancellation resolves its target from the stored handoff; it never accepts a caller-selected target or Host ID. Queued cancellation needs no target service or credentials. A loaded runner aborts only that child, while an absent runner uses a bounded best-effort request to the bound Host task. A late Host acceptance cannot bind to a cancellation-requested child. Terminal work is never rewritten and unavailable Host control cannot undo a persisted cancellation request. Open **Delegations** from the source agent’s panel page. The history shows handoff and child states. Use **Cancel child** on the specific queued or running row and **Refresh delegations** to check the outcome.

**Peer notes.** Configure directed note grants in **Agent access**. Sending asks the original conversation owner for confirmation with a 30-second deadline; denying, timing out, revoking access or changing the source binding prevents the send. Both agents must share their configured Telegram owner, and Discord-originated requests also require matching Discord owners. Notes are explicit untrusted messages stored on the Server, never instructions or authorization. Receiving a note does not start the recipient; it reads notes only during its own chat task. Reading marks a bounded page read without starting work or sending a reply. Each inbox retains at most 100 entries of up to 1,000 characters; a full inbox never evicts unread notes, and read entries may be reclaimed for new sends. Source conversation and grant checks apply again on reading and saved-result replay. Backups and saved task/tool outcomes may retain copies of note content after inbox reclamation.

**Creating an agent fails.** The creation form appears only when provisioning is configured (the installer does this automatically). Typical causes: the bot token is already bound to another agent, `AGENT_HOST_IMAGE` still points at an image resolved before a rebuild (recreate the server to resolve the new ID), `SERVER_CONTAINER_NAME` is wrong, or the server cannot read the Docker socket (`DOCKER_SOCKET_GID`). The setup page shows pending, in progress, failed, interrupted, or cancelled; a failed setup keeps its resources and volumes. Interrupted work, for example after a server restart, is never retried automatically; use **Retry setup** on the agent's page. It keeps created resources and can fail until existing resources are reconciled.

**A container is reported missing or stopped.** The panel inspects Docker on each refresh. Start a stopped container from the agent's page. A missing container is never recreated silently, and its volumes stay in place.

**Browser tasks fail.** Agents drive headless Chromium through the terminal inside their own container. Confirm the container has outbound network access and enough memory (1 GiB limit).

**Unexpected state.** Resources the server did not create, or that disagree with its registry, appear as *untracked* or *missing* in the status inventory. Nimbot never adopts or deletes them automatically; inspect them with `docker ps -a --filter label=io.nimbot.agent-id`.

### Scheduled tasks

Open **Manage schedules** on the agent page for the last run outcome, execution
status, and recent history. The owner can use `/schedules` to check next run times
and enabled state without contacting the Host. The server checks schedules at
startup and every 30 seconds, so admission is not guaranteed at the exact second
shown in the panel. Once enqueued, a task can also wait behind earlier work in the
agent's FIFO queue.

**Skipped: agent unavailable or owner chat unlinked.** Check that provisioning is
complete, the container is running, the Host is reachable, and the owner's private
Telegram chat is linked. The owner must send that bot a private message; a
connected polling loop alone does not link the chat. Nimbot never starts a stopped
container for a schedule. Only the first not-ready skip of a consecutive streak
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
minutes anchored to creation time. See [Scheduled tasks](../README.md#scheduled-tasks)
for cadence rules and limits.

## Security limitations

- Nimbot is intended for trusted, self-hosted deployments. Docker containers alone do not isolate hostile multi-tenant workloads.
- Managing containers gives the server access to the Docker Engine API, which is equivalent to root on the host. A compromise of the server or panel is a compromise of the host. The fixed container template limits what the server asks Docker to do, not what an attacker controlling the server could do. Rootless Docker reduces the exposure and is recommended where practical. Without panel provisioning, the server needs no Docker access.
- Agent containers run as a non-root user with all capabilities dropped, `no-new-privileges`, CPU, memory, and process limits, no Docker socket, no server credentials, no published ports, and a private network shared only with the server. Agents cannot reach each other's API or workspace.
- Agent containers have unrestricted outbound network access, including to private addresses reachable from the host's network. Disk usage of agent volumes is not limited. Apply either restriction on the host if you need it.
- The Host and OpenCode run as the same user inside each container. The model's shell can read or modify Host state and read the Host API credential. Execution identity stored there is correlation data, not authorization for Server operations. Supplying identity to the Host does not enable tools; only the Server policy can grant operations, and no permission is derived from container state.
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

On server startup, a restored Telegram task remains queued until its verified
reply bot is attached. The queue keeps FIFO order, so later tasks wait behind
that task rather than executing it without a return route. Discord tasks at the
head of the queue can run without a Telegram connection. A failed Telegram
identity check leaves its saved work queued; restore a valid token and restart
the server before expecting that work to resume.
