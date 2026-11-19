# Nimbot

**Your AI agents, on your own server.**

Nimbot is a self-hosted platform for creating and managing persistent AI agents through a web panel and talking to them through Telegram and optional Discord direct messages. Each agent runs in its own Docker container with a persistent workspace, a terminal, and a browser, and keeps working on long-running tasks while you are offline.

> **Project status:** The MVP is complete. Installation through Docker Compose has been validated on macOS with Docker Desktop and on a clean Linux server.

The self-hosted software is free under [Apache 2.0](LICENSE); you pay separately for your infrastructure and AI provider. A separate paid plan where we host your bots is planned for later. Managed hosting is not available yet, and pricing and plan details are to be announced.

## Installation

With Docker and its Compose plugin installed and running, open a terminal and run:

```sh
curl -fsSL https://raw.githubusercontent.com/celeris-it/nimbot/main/install.sh | bash
```

The installer supports Linux and macOS, downloads the code, builds the images, generates configuration, and starts the panel. It asks for a password and offers localhost access or an existing HTTPS origin. No Node.js, pnpm, or Git is required on the host. Only one installation per Docker Engine is supported. Use the [versioned installer option](docs/INSTALL.md#install) to install a published tag on the supported upgrade path.

## Upgrade

For an installer-managed deployment, choose a supported release tag and run:

```sh
curl -fsSL https://raw.githubusercontent.com/celeris-it/nimbot/main/upgrade.sh | bash -s -- --version vX.Y.Z
```

Replace `vX.Y.Z` with the target tag. The upgrade backs up the installation, updates the Server and existing Agent Hosts, and keeps agent data and configuration. The panel and bots are unavailable during the maintenance window, and active tasks can be interrupted. See [supported upgrade paths and recovery](docs/INSTALL.md#upgrade).

## Uninstall

To uninstall while retaining data, run `bash "$HOME/.local/share/nimbot/uninstall.sh"`. Add `--purge-data` to explicitly delete agent and server data after confirmation. Upgrade backups, images, and source files are kept.

See [docs/INSTALL.md](docs/INSTALL.md) for a custom directory, HTTPS, BotFather linking, and AI provider authentication. [docs/OPERATIONS.md](docs/OPERATIONS.md) covers backup and restore, troubleshooting, and security limitations.

Fresh installations start with zero agents. Sign in to the panel and create each agent with a name, optional instructions, its owner's numeric Telegram user ID, and a token from a distinct bot created in BotFather. Nimbot verifies the bot, provisions the agent, and provides its Telegram link. Open **Configure AI providers** on that agent’s setup page. Save an API key for OpenAI, Anthropic, Google, or OpenRouter, sign in to OpenAI with a ChatGPT device code, or connect an OpenCode Console workspace. Each agent has its own credentials and login method; then send its bot a private message. The chat is linked automatically on first contact; no /start command is required.

No Telegram or per-agent environment variables are required. `.env` contains administrator authentication and trusted deployment settings; internal Agent Host credentials are generated automatically.

## Features

- Create, list, configure, start, stop, and delete agents through an authenticated web panel.
- Give each agent a distinct Telegram bot, owner-bound private chat, Docker container, and persistent workspace.
- Optionally connect a Discord bot and owner DM to the same agent, workspace, AI context, and durable task queue. Configure, replace, test, and remove the connection from the panel.
- Run terminal commands, read and write files, and browse public websites through OpenCode over ACP.
- Queue tasks durably, report progress, request owner approvals, and return results through the originating bot and chat.
- Choose a model per agent, review tokens and reported cost by agent or task, and pause the agent’s queue when OpenCode reports an exhausted Console budget or Go allowance.
- Run saved prompts once, daily, weekly, at fixed intervals, or on authenticated webhook requests configured from the panel, with results delivered to the owner's Telegram chat.
- Send documents up to 10 MiB to a Telegram agent and ask it to return generated files in the same chat.
- Cancel a running task without affecting other agents or blocking later queued tasks.
- Preserve conversations, files, configuration, and chat bindings across restarts; safely mark interrupted tasks instead of replaying potentially completed actions.
- Replace revoked bot tokens securely and retain persistent volumes by default when deleting an agent.

The panel uses one locally configured administrator account. Each agent has one Telegram owner; everyone else is ignored, including owners of other agents. There is no management bot, shared selected agent, or `/use` workflow. Tasks, progress, approvals, and results use their originating channel. Each optional Discord connection has its own configured owner and private DM binding.

### Telegram commands

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

Send one document at a time. Documents of any file type are stored as received,
up to 10 MiB. Reply to the original document with instructions or use the
workspace path in a later message. Ask the agent in the chat to return a file
and it can attach one document of up to 10 MiB after the task succeeds.
See [attachment handling and recovery](docs/OPERATIONS.md#telegram-documents).

Agent creation, configuration, token replacement, container start/stop, and deletion are panel actions. Stopping a container safely interrupts active work; `/stop` cancels the task while leaving the container available.

## Architecture

One Nimbot Server serves the administration panel, maintains a separate Telegram long-polling connection per agent, and manages agent containers on the same machine.

```text
  Web panel (admin)      Telegram agent bots A, B
          |                         |
          +------------+------------+
                       |
                       v
              +------------------+
              |   Nimbot Server   |
              |                  |
              | Telegram Adapter |
              | Agent Registry   |
              | Task Router      |
              | Scheduler        |
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
   | OpenCode/ACP|           | OpenCode/ACP|
   | Tools       |           | Tools       |
   | Workspace   |           | Workspace   |
   +------+------+           +------+------+
          |                         |
          v                         v
   Persistent Volumes        Persistent Volumes
```

- **Nimbot Server:** authentication, bot credentials and connections, owner authorization, agent registration, task routing and scheduling, container lifecycle, and diagnostics. Agent-generated commands never run on the host OS.
- **Agent Host:** one container per agent, using OpenCode as its sole AI engine and running the tools, tasks, workspace, and conversation state. An authenticated private API connects it to the server. Platform-specific code stays outside the runtime; OpenCode-specific code stays behind the engine interface.
- **Panel:** Svelte 5, TypeScript, Vite, and daisyUI. Hono serves compiled assets and the same-origin API from one process. JavaScript is required; visible views refresh every five seconds and forms submit without document reloads.
- **Storage:** SQLite and Docker named volumes. No PostgreSQL, Redis, Kubernetes, message broker, or separate frontend service is required.

The stack uses strict TypeScript on Node.js, pnpm workspaces, Hono, Zod, grammY, Drizzle for task persistence, Node's built-in SQLite API for the registry, Docker, Playwright, Vitest, ESLint, and Prettier.

The application-tool bridge follows the existing approval exchange: the Host now persists tool-request events and accepts authenticated outcomes; the Server dispatcher reads these events, validates each operation against Server state, and posts the outcome back. Connections between the Server and Host originate on the Server, so this also supports native Server runs without a container callback address or a new Server listener. Local memory operations stay in the Host. `tests/host-polling.integration.test.ts` measures the existing exchange over local HTTP with the production one-second polling interval, deliberately emitting just after a poll. It guards a five-second transport allowance within a planned 60-second ordinary tool-call budget; this is a local baseline, not a deployment network latency guarantee. The MCP adapter is implemented; the Server consumes tool events and dispatches through a guarded service with durable write replay protection. Application tools stay disabled for every task until a Server policy grants operations, so nothing is exposed by default.

**Structured approvals (Server).** Service-validated actions go through an approval gate: per-agent rules (Ask each time, Deny, Always allow for verified read-only actions) matched on a trusted operation identifier and exact target, with deny taking precedence and asking as the default. Questions go to the task's own Telegram chat or Discord DM using single-use buttons, rechecked for the current owner and binding at click time. Rules, grants and the action fingerprint are checked again immediately before the side effect; expiry, failed delivery, cancellation or a restart deny, and an interrupted execution is recorded as uncertain and never replayed. The panel's **Approvals** page edits rules and shows decision history. Peer note sends, delegation handoffs and mutating external MCP tools use this gate. External reads honor exact Deny and Ask rules; their default is the administrator-granted access. Existing OpenCode permission approvals are unchanged.

**Agent communication and delegation (Server).** Directed panel grants enable peer discovery, notes and delegation handoffs for chat tasks only; no grants means no peer tools. The Server returns only granted agent IDs and bounded display names. Sending a note asks the initiating owner for confirmation with a 30-second deadline and rechecks the exact target grant before storing it. Recipients read explicit, untrusted messages in their own tasks; receiving or reading a note never starts work. Notes live in `agent_notes` in Server SQLite, capped at 1,000 characters each and 100 retained entries per recipient. A full inbox preserves unread notes and rejects new sends; read entries can be reclaimed. Unread pages are atomic and bounded by count and UTF-8 bytes. Grant and saved source-conversation checks apply before reading and before replaying saved results. The `agent_delegate` tool asks the originating owner for approval with a 30-second deadline, then immediately returns a pending handoff ID. It stages bounded one-hop briefs and atomically admits a child when its parent completes and authorization still holds. The task service activates target workers only after that commit and reconciles committed queued handoffs on startup, preserving them if target loading fails. Accepted parent cancellation discards the handoff even if the Host returns a completed result. Child outcomes now commit with terminal state as immutable JSON capped at 8,192 UTF-8 bytes, with truncation flagged; recovery records interrupted work without repeating it. Ordinary chat results remain on the Host. Structured child approval routing now has a Server-only relay that validates the saved handoff, current grant and original owner conversation, uses the source agent bot and rejects stale or foreign callbacks. The `agent_delegation_status` tool now reads a source agent's own handoff state and bounded result, rechecking both the saved parent conversation and current chat grants on each call. A pending handoff stays pending for the rest of its parent turn; results are read from later turns as untrusted data. Native OpenCode child permission requests also have a bounded relay handler that checks the child's exact accepted Host task ID and forwards single-use owner decisions to that Host; these permissions keep their existing semantics and do not match structured rules. Ending the child turn or closing either service denies pending requests. Child outcome delivery now has a source-service relay that reads only committed bounded results, rechecks the saved initiating conversation and live grant before each message part, and persists notification intent before sending. Delivered, partial and uncertain sends are never automatically repeated; a later source task can retrieve the result through the status tool. This relay never starts a task. Delegated children now execute in the destination FIFO after rechecking the admitted handoff, original conversation, grant and destination readiness. The destination must pass the existing linked Telegram bot, owner chat and provisioning checks; failed checks record `not_ready` without invoking its Host. The Server selects a fresh OpenCode session outside the prompt, so the child receives only the explicit source brief plus its own configured agent instructions and cannot replace the saved owner conversation. Production children receive no application-tool capabilities, preventing further delegation. A queued or running child never holds the source agent turn open. Startup and source-bot attachment now recover terminal results that have no notification intent, with paginated source-scoped scans and fresh grant/origin checks. Existing intents are skipped, so interrupted delivery is never replayed. Missing source credentials or an unattached Telegram bot leave results pending for a later resume or attachment. Outcome recovery never starts an agent task. The task service now supports cancellation of a specific child: queued cancellation commits its outcome without stopping earlier target work, and running cancellation persists before aborting that child. Permission relays reject a cancellation-requested child; late success and restart recovery preserve cancellation. The requesting agent can see the cancellation request through its status tool. Queued children now pause during pending container actions and after recorded completed or interrupted stops; starting that target resumes its FIFO. Deleted-target reconciliation atomically fails only correlated queued children as `not_ready`, without loading target credentials or repeating running work. Prior results remain unchanged, and result delivery still requires a live grant and saved origin. Authenticated panel APIs now expose paginated delegation metadata and source-scoped cancellation, including queued children whose target cannot load. History omits parent prompts and child output; running cancellation uses the existing runner or the exact bound Host ID. Open **Delegations** from the source agent’s panel page to review handoffs and cancel a specific queued or running child.

**External MCP tools (Server).** The panel’s **MCP catalog** stores administrator-selected HTTPS definitions, pinned tool schemas and read/write classifications in Server SQLite. Integrations start with no agent grants. Use **MCP access** on an agent’s page to grant access and manage its bearer credential. Credentials live in private Server files, and the panel shows only whether one is configured. Changing the endpoint revokes existing grants and retires their credentials. The catalog’s **Test connection** lists remote tools from the Server. Administrators review schemas and save the tools they want to approve. The Server rejects invalid or unsupported schemas before saving; argument validation uses the approved schema without type conversion or inserted defaults. Missing tools or changed input schemas detected by the execution service are disabled in the catalog until explicitly reviewed. The panel identifies affected tools; saving unrelated settings preserves their blocks. Review the schema and access, confirm the tool’s review checkbox, then save to approve it again. Granted catalog tools are now available to verified Telegram and Discord chat tasks through the bundled adapter. Scheduled, webhook and delegated tasks receive none. Each turn carries at most 23 catalog tools and 16 KiB of tool metadata, leaving room for memory and peer operations within the 32-operation limit.

MCP connections originate on the Server and use the saved HTTPS endpoint and the selected agent’s optional bearer credential. The administrator is trusted to choose endpoints. Remote servers receive MCP negotiation/session traffic, the selected tool name and its validated argument object. Writes ask the initiating owner for approval with a 30-second decision budget; the Approvals page uses `mcp.write` or `mcp.read` and the exact target `<definition ID>:<remote tool name>`. External tools do not qualify for persistent Always allow rules. Calls have a 30-second remote lifetime, four listing pages, a 128 KiB aggregate response budget and a 12 KiB result limit. Results redact the endpoint and configured bearer value. Ending a task cancels pending calls where supported; it cannot undo a remote side effect. Invocation intents are saved before execution, and saved or uncertain outcomes prevent a retry from repeating the same invocation.

**Agent memory (Agent Host).** Each Host keeps explicit notes in `memory.sqlite` in its task-state volume: title, bounded content (4,000 characters), up to 10 tags, source task, timestamps, and an optional expiry, capped at 500 notes. Search is local SQLite FTS5 keyword and tag retrieval ranked by match and recency, returning at most 10 notes and 8,000 characters. Notes are private to that agent and never copied from transcripts automatically; the agent reads them as untrusted context. The model can edit the file from its shell, so every read re-applies the limits, skips malformed rows, and rebuilds an inconsistent index. The panel's **Review memory** page lists notes (paginated) and deletes them, which also removes their search entry; earlier chat transcripts and backups may still hold copies. Memory is opt-in per agent: the panel's memory page has a switch, off by default, that lets the Server grant the memory tools to that agent's chat tasks only. Scheduled and webhook tasks never receive them, and turning the switch off revokes access for running tasks. `tests/memory-fts5.integration.test.ts` (part of the Docker suite) fails if the image loses FTS5.

### Agent lifecycle

The server verifies BotFather tokens with Telegram and rejects bots already linked to another agent. Tokens remain in private server-side files; SQLite holds credential references. Replacing a token must preserve the bot's identity and takes effect after a server restart. Switching an existing agent to a different bot is outside the current scope.

Agent names and instructions persist across restarts. Instructions are snapshotted as context for each new task; edits do not modify running work or the Telegram bot's profile. Names allow up to 128 characters and instructions up to 4000 characters.

Compose enables provisioning using a fixed Docker template. `AGENT_HOST_IMAGE` is resolved to an immutable image ID at server startup without pulling; recreate the server after rebuilding the image. Docker Engine API v1.47 is required. Each agent gets three labeled volumes (workspace, engine state, task state), a private bridge network shared with the server, and a separate generated Host API credential.

Installer-managed resources carry an installation label so uninstall only removes resources belonging to that installation. Provisioning records state, resource references, and creation intentions before Docker mutations. Failed, cancelled, or interrupted setup retains its resources for explicit retry or cleanup and cannot execute tasks. Resource inventory reports missing, untracked, and uncertain resources without silently adopting, recreating, or deleting them. A lost Docker response is treated as uncertainty, not proof that an operation failed.

Deletion requires explicit confirmation and keeps volumes unless data deletion is separately selected. It stops polling and removes the local agent binding and credentials. Deleting the Telegram bot identity is a separate action in BotFather.

Explicitly deleting agent data removes its workspace, OpenCode state, and Host task state, including private memory and the tool outbox. Approval history, delegation records, peer notes, and the MCP catalog live in the separate Server database. Deleting an agent also revokes its MCP grants and retires its stored MCP credentials. Backups can still contain copies of deleted data.

### Tasks and recovery

Incoming messages and task state are committed before execution. Each agent has a persistent FIFO queue and runs one turn at a time across its conversations; duplicate Telegram updates are deduplicated by bot ID and update ID. Commands remain responsive during execution. Progress, approval buttons, and results stay in the originating agent's chat, and long answers are split to fit Telegram limits. Approval callbacks check the owner, agent, and task; unanswered or undeliverable approvals are denied.

`TASK_TIMEOUT_SECONDS` bounds execution (10–3600 seconds, default 600). Failed or cancelled tasks free the queue for the next message. Task submissions and uncertain Docker mutations are never retried automatically. Transient reads and engine startup failures use bounded retries; a failed bot connection does not stop other bots.

The Agent Host saves its ordinary OpenCode conversation session ID in its task-state volume and loads it for later turns. Server-selected `sessionMode: "fresh"` metadata starts a separate conversation without reading or replacing that saved session, so an ordinary turn afterward resumes its prior history; the mode is persisted with the Host task, stays outside the prompt and does not enable tools. If a session cannot be loaded, it starts a new one. Running tasks become interrupted after a Host restart rather than being replayed. On server restart, saved agents reconnect with their existing owners and chat bindings, and unfinished operations are recorded as interrupted. Missing or stopped containers are detected rather than silently recreated.

The Server resolves the agent and task from its running SQLite record and sends an `execution` object with `agentId` and `serverTaskId`, saved atomically with the Host task before execution and passed to the engine separately from the prompt. The Server saves the accepted Host ID before processing events; if it cannot save that association, it requests cancellation and does not retry submission. Both stores retain the association after restart. A repeated agent/Server-task pair cannot execute again. Prompt-only Host submissions remain supported and carry no execution identity. These fields only correlate records and grant no application tools.

The task service resolves tool operations from Server-owned policy. When a policy grants access, a short-lived capability travels separately in `tools`, and the Host passes a snapshot to the engine without persisting its token. The Server's internal dispatch guard binds each token to its agent, task, saved Host ID, original conversation, operations, and expiry, and rechecks current authorization. Cancellation, execution ending, service shutdown, and expiry revoke access; restarting cannot restore tokens. Scheduled tasks and webhooks never receive capabilities, even when a policy is configured.

For tool-enabled turns, the engine starts a bundled HTTP MCP adapter on container loopback and registers it on new or restored ACP sessions. Only granted, Host-registered handlers are discoverable. Missing handlers, stale identity, or unsupported HTTP MCP fail before prompting. The adapter uses a separate per-turn credential, keeps task identity and capabilities out of model-visible tool arguments, bounds requests and responses to 64 KiB, and permits at most four concurrent calls and 100 calls per turn. Each call has a 60-second timeout capped by capability expiry. Ending the prompt or stopping the engine closes the endpoint and aborts pending calls; stopping also waits for adapter startup to settle before another turn can begin.

Host-registered Server tools now use a durable outbox in the task database. Each invocation and its `tool_request` event are committed together before waiting for a result. Arguments and outcomes are limited to 16 KiB each, with four pending requests and 100 invocations per turn. Reusing an invocation ID with changed arguments is rejected; identical replays return the saved outcome without publishing another request. Authenticated Host endpoints report whether an invocation is still awaiting a result and accept a single immutable outcome. Cancellation and timeout emit `tool_cancel` events; a Host restart marks unresolved requests interrupted, and no old waiter is restored. Capability and Host API credentials are not included in these events. Server dispatch and write replay protection are implemented, and private memory handlers run locally in the Host; Host records are not trusted authorization or proof of a Server side effect. Server cancellation immediately aborts active tool calls without waiting for another Host poll and rejects later tool requests. The dispatcher stops waiting even if a handler ignores cancellation, aborts the handler scope on every exit, and never replaces a saved cancelled write outcome with a late result. It rechecks authorization immediately before entering a handler.

Terminal and filesystem tools run through OpenCode inside the container. Browser automation uses headless Chromium through terminal execution with the bundled Playwright tooling; no external browser service is required. Client-side ACP filesystem and terminal capabilities remain disabled.

### Model selection and usage

Open **Model and usage** from an agent's setup page. Choose an enabled model or
**Automatic** to use OpenCode's current default. The selection applies when the
next task starts and uses the same conversation. If a saved model becomes
unavailable, the queue waits for it to return or for the administrator to change
the selection.

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
Providers without published quota data remain usable, and the panel shows
**Quota unavailable**. Limits apply at the start of a task and reflect a
snapshot of a possibly shared account.

### Scheduled tasks

Open **Manage schedules** on an agent's page to create, edit, pause, resume, run,
or delete saved prompts. The panel shows each schedule's next local run time,
enabled state, and recent run outcomes. `/schedules` lists schedules in the owner's
Telegram chat even if the container is stopped.

To create a timed schedule in Telegram, message your agent as usual, for example
“Remind me every Monday at 9 AM to review invoices.” The agent asks for any
missing details. Review the task, cadence, time zone, and first run, then choose
**Confirm** to save it or **Cancel** to discard it. A newer preview replaces the
previous one, and previews expire after ten minutes or on server restart.

Set the installation's **Schedule time zone** in the panel under **Settings**.
It starts at `UTC`, applies to new schedules created from Telegram, and prefills
the editable time zone for new schedules in the panel. Saved schedules retain
their own time zone.

| Cadence | Timing |
|---|---|
| Once | One local date and time; disabled after its due occurrence is handled, including a skipped or missed run |
| Daily | The same local time each day |
| Weekly | The same local time on one or more selected weekdays |
| Interval | Every N minutes, anchored to creation time across pauses, edits, and restarts |
| Webhook | On an authenticated POST request; no timed occurrence |

Limits are 20 schedules per agent, an interval of at least 15 minutes, a name of
up to 60 characters, and a prompt of up to 4000 characters. A local time skipped
by daylight saving runs at the next valid instant; a repeated time runs only at
its first occurrence. Intervals use elapsed minutes. These are fixed rules, with
no scheduler-specific environment variables.

The same operations are available under the authenticated
`/api/agents/:id/schedules` API. Mutations use POST. Schedule settings are form
fields `name`, `prompt`, `timeZone`, and `cadence` (a JSON object with its kind and
matching fields); interval anchors are assigned by the server.
Read or change the global zone with `GET` or `POST /api/settings/schedules`.
The POST accepts the `timeZone` form field.

The scheduler runs inside the Nimbot Server, once at startup and every 30 seconds.
It records each occurrence, enqueues its task, and advances the next run in one
SQLite transaction. A repeated tick or server restart cannot enqueue the same
timed occurrence twice. A saved due occurrence up to 10 minutes late is considered
once; older occurrences are recorded as `missed`. The next run advances past the
current server time, without replaying a backlog. A previous task from the same
schedule still queued or running produces `skipped_overlap`. A stopped or
unavailable Host, incomplete setup, or unlinked owner chat produces
`skipped_not_ready`. Containers never start automatically. The server attempts a
durable notification only for the first not-ready skip of a consecutive streak.

Each executed run uses the agent's AI provider credits and shares its existing conversation
context and FIFO queue with chat messages. Only the final result or failure is
sent, prefixed with the schedule name saved at enqueue time; there are no
`Working: …` messages. Approvals and `/stop` use the owner's Telegram chat as
usual. Scheduled delivery is Telegram-only.

**Run now** uses the same readiness and overlap checks and records its outcome
without changing the next timed occurrence. A paused schedule can still be run
manually. Resume recomputes the first future occurrence; an expired once schedule
needs a future date before it can resume. Deleting a schedule removes its run
history and stops future runs; already queued or running tasks are kept.
Deleting an agent removes its schedules and run history while preserving volumes
unless data deletion was explicitly requested.

#### Webhook activation

Choose **Webhook** in the schedule's **Activation** field and save. Open **Show
webhook details** to get its URL and private Bearer token. The URL uses the
configured `PANEL_URL`; external callers need to reach that origin. Use HTTPS
when exposing it outside localhost. Tokens are stored in the server database,
excluded from schedule listings, and visible only through the authenticated
panel API. **Regenerate token** immediately revokes the previous token. Changing
to a timed activation or deleting the schedule also revokes webhook access.

```sh
curl -X POST 'https://nimbot.example.com/hooks/schedules/SCHEDULE_ID' \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"event":"deployment","environment":"production"}'
```

An empty body runs the saved prompt. An optional JSON body of up to 16 KiB is
appended as external data to the task prompt and persisted with the task. It
cannot override the saved prompt or delivery target. Cookies and panel login
are not used for this endpoint. Requests return `202` once the task is durably
queued, `401` for invalid credentials, `400` for invalid JSON, `413` for an
oversized body, or `415` for an unsupported content type. A paused, changed,
or not-ready schedule returns `409`; an unavailable scheduler returns `503`.
Responses contain only an `outcome` and, on failure, an `error` message.
Results and approvals use the owner's Telegram chat.

A request that arrives while an earlier run of the same schedule is still
queued or running is not skipped: it becomes its own task, with its own
payload, in the agent's durable FIFO queue, and runs in arrival order. One
webhook schedule can hold up to 20 unfinished tasks; further requests return
`429` until the backlog drains. Timed occurrences and **Run now** keep the
overlap skip. A stopped or not-ready agent queues nothing and returns `409`.

Webhook admission is limited to five attempts per rolling minute. Recent
skipped and manual runs count toward this limit; additional requests return `429` with
`Retry-After: 60` before the Host is contacted. The limit survives server
restarts. Pausing blocks webhooks; **Run now** still works while paused.
Admission rechecks the enabled state, settings, token, and backlog before
persisting work. Webhook invocations do not have automatic retries or event
deduplication: a repeated request creates another task. External callers
should avoid blindly retrying uncertain deliveries. No container starts
automatically.

The authenticated API exposes `GET /api/agents/:id/schedules/:scheduleId/webhook`
and `POST /api/agents/:id/schedules/:scheduleId/webhook/rotate` to read or
regenerate `{url, token}`. Create or edit with `cadence={"kind":"webhook"}` and
`timeZone=UTC`, alongside the usual name and prompt form fields.

### Persistence and diagnostics

Server state in `server.sqlite` includes agents, owners, instructions, verified bot identities, chat bindings, provisioning and container-operation metadata, the durable task queue, and schedules with their saved prompts, cadences, time zones, UTC next-run timestamps, and private webhook tokens. It retains the latest 20 run records per schedule and reads execution status from the associated task row. Private `bot-secrets`, `discord-secrets`, and `host-secrets` directories live alongside the server SQLite database in `SERVER_STATE_DIR` (default `.nimbot/` for native runs). Compose mounts a named server-state volume. Each agent separately persists workspace files, OpenCode sessions and provider credentials, and task records/results. Back up all of these and `.env`; backups contain secrets.

Provider credentials are stored only in each agent's private engine-state volume. The panel forwards authentication operations over that agent's authenticated internal API; OAuth tokens never return to the server or browser. OpenAI supports an API key or ChatGPT device login, Anthropic, Google, and OpenRouter support API keys, and OpenCode Console uses device login. The container must be running and idle to change authentication. Tasks stay queued during device login and are eligible to start once the attempt ends. Other agents remain independent. OpenCode renews OAuth tokens locally. In **Model and usage**, choose an enabled model for the agent or use **Automatic** to follow the OpenCode default. The Agent Host validates API keys with the provider before saving. A rejected or unverified replacement leaves the previous credential active. Validation checks access to an authenticated provider endpoint. Balance and model access are outside this check. Disconnecting removes the local credential without revoking it at the provider.

Both applications expose health checks and emit structured JSON logs with agent and task IDs. Prompts and results are not logged, and credentials are redacted. `NIMBOT_LOG=silent` disables logging. The panel reports bot polling, owner chat linking, container status, and authenticated Host readiness separately; Host readiness checks workspace access and busy state. **AI provider status** shows separate checks for active credentials and when each result was recorded. Stopping an agent captures a task observation, and later refreshes confirm its persisted outcome when the Host is reachable.

**Owner alerts.** The Server sends a Telegram notice to the agent's linked owner
when the provider rejects a saved credential, the same schedule fails three
times in a row, or Docker reports an unexpected container stop, disappearance,
or automatic restart. One notice is attempted per incident. Provider checks
run at startup, every five minutes, and after credential changes. They make
no inference requests and leave task admission alone. For ChatGPT and OpenCode
Console, OpenCode's reauthentication signal triggers the notice. A connection
without a conclusive signal appears as **Unverified**. See the
[operations guide](docs/OPERATIONS.md#owner-alerts-and-provider-status).


## Security limitations

Nimbot is intended for trusted, single-server self-hosted deployments. Docker containers alone do not provide sufficient isolation for hostile multi-tenant workloads.

- The server's Docker Engine access is equivalent to root on the host. A compromised server or panel can compromise the host; the fixed provisioning template does not constrain an attacker controlling the server. Rootless Docker reduces this exposure where practical.
- Agent containers run as non-root with all capabilities dropped, `no-new-privileges`, CPU/memory/process limits, no additional swap, no published ports, and no Docker socket or server credentials. Each agent has its own network, volumes, and internal API token.
- Outbound network access is unrestricted, including reachable private addresses. Agent volume disk usage is not limited. Apply restrictions on the host if needed.
- Panel passwords use scrypt hashes. Sessions expire after eight hours and end on server restart. Cookies use HttpOnly and SameSite restrictions, with Secure cookies for HTTPS. Panel state changes require same-origin checks; webhook activation uses a per-schedule Bearer token. Login is limited to five attempts per fifteen minutes. Remote access requires HTTPS.
- Telegram and Discord tokens stay on the server and never enter agent containers, model context, logs, or task events. Telegram messages and AI provider requests leave the server.

See the [replacement server recovery procedure](docs/OPERATIONS.md#prepare-a-replacement-docker-host) to restore agent data and recreate stopped containers from the panel.

## Development

Use Node.js 22.13 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Start the compiled server with `pnpm start:server`. Generate its administrator password hash with `pnpm panel:password`; `.env.example` documents deployment settings. See [CONTRIBUTING.md](CONTRIBUTING.md) for panel development and browser tests.

| Path | Responsibility |
|---|---|
| `apps/server/` | Panel API, Telegram, registry, routing, and container management |
| `apps/agent-host/` | AI engine, tasks, and persistent workspace inside each container |
| `apps/panel/` | Administration UI |
| `packages/` | Shared code when needed by multiple apps |
| `infrastructure/docker/` | Application Dockerfiles |
| `tests/` | Integration and panel end-to-end tests |
| `docs/` | Installation and operations guides |

Default Vitest tests need no Docker, Telegram, or AI provider connection. A
multichannel integration test exercises simultaneous Telegram and Discord tasks
through the real Host API with a simulated engine, including shared context,
owner approvals, duplicate submissions, and server restart recovery. They cover authentication, CSRF, bot linking, owner authorization, routing, task persistence, cancellation, deduplication, and recovery. Panel browser tests use compiled assets and simulated services. Opt-in Docker tests verify lifecycle, isolation, response-loss recovery, and container hardening across recreation and restarts:

```sh
docker build -f infrastructure/docker/agent-host.Dockerfile -t nimbot-agent-host .
NIMBOT_TEST_DOCKER_IMAGE=$(docker image inspect nimbot-agent-host --format '{{.Id}}') pnpm test integration
```

The replacement server recovery test restores the three agent volume archives
and the saved Server state. It checks that Docker assigns new container and
network IDs, that the owner binding and queued task survive, and that the queue
stays held until an explicit **Start** and authenticated Host readiness.

The Docker suite includes `tests/opencode-mcp.integration.test.ts`, a compatibility gate for the exact OpenCode version pinned in the Agent Host Dockerfile. It verifies the bundled adapter's HTTP MCP discovery, structured tool calls, registration on a new session and a session restored in a new ACP process, and cancellation during a pending tool call. It also runs the production engine without tool access and checks that the previous process's adapter is absent. It also starts a fresh isolated turn between two ordinary turns and verifies that their histories stay separate and the saved owner session remains unchanged. The same fixture creates a private memory note through the production engine, reopens its SQLite store, and retrieves the note in a distinct fresh session with only search access. The container lifecycle test verifies that memory survives container recreation with retained volumes and is absent after explicit volume purge. The fixture runs as the image's non-root user with external networking disabled, using a local simulated model, a fixture-only echo handler, and the production memory handlers. Run it separately with `NIMBOT_TEST_DOCKER_IMAGE=$(docker image inspect nimbot-agent-host --format '{{.Id}}') pnpm test tests/opencode-mcp.integration.test.ts`. This gate enables tools only inside its fixtures; direct chat tasks without a grant still pass no MCP servers.

`NIMBOT_TEST_DOCKER_SOCKET` optionally selects a different Unix socket. Tests create uniquely named resources and clean them up. CI runs lint, type checking, build, tests, and panel browser tests.

## Discord and outbound notifications

Outbound notifications use an internal server interface. The internal server
interface and Telegram adapter reuse the agent's verified bot connection and
owner chat, split long text, and report uncertain sends without retrying them.
The Discord HTTP adapter resolves owner-only DMs, splits text, suppresses mentions,
and honors rate-limit cooldowns without retrying uncertain sends. Both adapters
remain internal. Discord configuration now has server-side bot verification,
private credential files, SQLite metadata with string IDs, and authenticated
configuration API routes and panel forms to connect, replace, and remove a bot.
A durable notification store and delivery wrapper now record intent and sanitized
results, deduplicate request IDs, and mark in-flight sends uncertain after restart
without replaying them. Only a content hash is stored, not notification text.
The authenticated Discord test API uses this durable path with a fixed test
message. It accepts only a request ID, resolves the saved owner on the server,
and allows five new notification attempts per minute per agent across channels.
Provider rate-limit responses count as attempts; locally blocked requests do not
extend the window. The quota persists across restarts.
Automatic task delivery is independent of this limit. The panel can send a test
and check its last request without resending it. Uncertain delivery is shown
explicitly; check your DMs before starting a new test. Configuration changes invalidate previously resolved delivery targets. Remove a Discord
connection before retiring its agent. Automatic task delivery continues through
its existing independent path.

The server runs a Gateway per
configured agent, persists owner DMs, and admits them to the same FIFO and Host
runner as Telegram. Progress, results, errors, and approval buttons return to the
saved origin; `/stop` in the Discord owner DM cancels its running task. Approval
interactions verify the active task and owner before applying a decision.
Task services belong to agents independently of their channel connections.
Inbox admission is idempotent after restart; interrupted running tasks are not
replayed. The panel reports Discord conversation state and owner DM linking separately
from Telegram polling and Host readiness. Recovery tests cover session resume,
replayed events, cross-channel deduplication and context, and restored FIFO work.

## Future work

The following ideas are deferred, not supported features or delivery commitments:

- **Messaging:** WhatsApp, Slack, shared agents, groups/topics, photo and media messages, Discord attachments, voice messages, management bots, and Telegram Managed Bots provisioning.
- **Nimbot messaging app:** a dedicated messaging app with [Matrix](https://matrix.org/) connectivity.
- **Agent capabilities:** multi-hop orchestration, shared memory and workspaces, richer memory retrieval, external MCP OAuth, arbitrary MCP stdio commands, and a tool marketplace.
- **Scheduled automation:** Discord delivery, cron expressions, additional event triggers, and chained automations.
- **User experience:** advanced dashboards and analytics, web chat, richer configuration, templates, browser terminals, workspace browsing, conversation search, and additional panel accounts.
- **Operations:** multi-server and distributed execution, advanced monitoring, automated backups, image management, alternative runtimes, and stronger isolation.
- **Managed hosting:** a separate paid offering; hosted accounts, billing, subscriptions, public registration, public multi-tenant hosting, organizations, marketplaces, and automatic external infrastructure provisioning remain outside the self-hosted product's current scope.

Keep additions focused on the documented features unless an extension is explicitly requested. Prefer simple local components and persistent state over new services or infrastructure.

## License

Nimbot is released under the [Apache License 2.0](LICENSE).
