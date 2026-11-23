# Nimbot architecture

One Nimbot Server serves the administration panel, maintains each agent’s Telegram and Discord connections, and manages agent runtime lifecycle on the same machine. Native development uses Server-managed Agent Host child processes. Docker packages the same Server and Agent Host processes in one non-root container per installation.

```text
  Web panel (admin)      Telegram and Discord bots
          |                         |
          +------------+------------+
                       |
                       v
              +------------------+
              |   Nimbot Server   |
              |                  |
              | Channel Adapters |
              | Agent Registry   |
              | Task Router      |
              | Scheduler        |
              | Process Manager  |
              | SQLite Database  |
              +--------+---------+
                       |
               Child processes
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
   Persistent directories    Persistent directories
```

- **Nimbot Server:** authentication, bot credentials and connections, owner authorization, agent registration, task routing and scheduling, process lifecycle, and diagnostics. Agent-generated commands run only in Agent Host processes, never in the Server process.
- **Agent Host:** a separate child process per agent in both native and Docker deployments, using OpenCode as its sole AI engine and running the tools, tasks, workspace, and conversation state. An authenticated private API connects it to the server. Platform-specific code stays outside the runtime; OpenCode-specific code stays behind the engine interface.
- **Panel:** Svelte 5, TypeScript, Vite, Tailwind CSS, and Iconify. Hono serves compiled assets and the same-origin API from one process. JavaScript is required; visible views refresh every five seconds and forms submit without document reloads.
- **Storage:** SQLite and persistent directories, stored in one named volume for the Docker deployment. No PostgreSQL, Redis, Kubernetes, message broker, or separate frontend service is required.

The stack uses strict TypeScript on Node.js, pnpm workspaces, Hono, Zod, grammY, Drizzle for task persistence, Node's built-in SQLite API for the registry, Docker, Playwright, Vitest, ESLint, and Prettier.

## Application tools

The Host persists tool requests as events. The Server polls those events,
validates requests against Server state, and sends authenticated outcomes back
to the Host. The Server initiates every connection to the Host. Local memory
operations stay in the Host. The Server records write outcomes to prevent replay
and uses a per-task policy to decide which tools to expose.

`tests/host-polling.integration.test.ts` emits an event just after a poll and
verifies a five-second local transport allowance within the 60-second tool-call
budget. The test uses local HTTP and the production one-second polling interval.

### Structured approvals

Service-validated actions go through an approval gate: per-agent rules (Ask each time, Deny, Always allow for verified read-only actions) matched on a trusted operation identifier and exact target, with deny taking precedence and asking as the default. Questions go to the task's own Telegram chat or Discord DM using single-use buttons, rechecked for the current owner and binding at click time.

Rules, grants and the action fingerprint are checked again immediately before the side effect; expiry, failed delivery, cancellation or a restart deny, and an interrupted execution is recorded as uncertain and never replayed.

The panel's **Approvals** page edits rules and shows decision history. Peer note sends, delegation handoffs and mutating external MCP tools use this gate. External reads honor exact Deny and Ask rules; their default is the administrator-granted access. Existing OpenCode permission approvals are unchanged.

### Agent communication and delegation

Directed panel grants enable peer discovery, notes and delegation handoffs for chat tasks only; no grants means no peer tools. The Server returns only granted agent IDs and bounded display names.

Sending a note asks the initiating owner for confirmation with a 30-second deadline and rechecks the exact target grant before storing it. Recipients read explicit, untrusted messages in their own tasks; receiving or reading a note never starts work. Notes live in `agent_notes` in Server SQLite, capped at 1,000 characters each and 100 retained entries per recipient. A full inbox preserves unread notes and rejects new sends; read entries can be reclaimed. Unread pages are atomic and bounded by count and UTF-8 bytes. Grant and saved source-conversation checks apply before reading and before replaying saved results.

The `agent_delegate` tool asks the originating owner for approval with a 30-second deadline, then immediately returns a pending handoff ID. It stages bounded one-hop briefs and atomically admits a child when its parent completes and authorization still holds. The task service activates target workers only after that commit and reconciles committed queued handoffs on startup, preserving them if target loading fails. Accepted parent cancellation discards the handoff even if the Host returns a completed result. Child outcomes commit with terminal state as immutable JSON capped at 8,192 UTF-8 bytes, with truncation flagged; recovery records interrupted work without repeating it. Ordinary chat results remain on the Host.

Structured child approval routing has a Server-only relay that validates the saved handoff, current grant and original owner conversation, uses the source agent bot and rejects stale or foreign callbacks. The `agent_delegation_status` tool reads a source agent's own handoff state and bounded result, rechecking both the saved parent conversation and current chat grants on each call. A pending handoff stays pending for the rest of its parent turn; results are read from later turns as untrusted data. Native OpenCode child permission requests also have a bounded relay handler that checks the child's exact accepted Host task ID and forwards single-use owner decisions to that Host; these permissions keep their existing semantics and do not match structured rules. Ending the child turn or closing either service denies pending requests.

Child outcome delivery has a source-service relay that reads only committed bounded results, rechecks the saved initiating conversation and live grant before each message part, and persists notification intent before sending. Delivered, partial and uncertain sends are never automatically repeated; a later source task can retrieve the result through the status tool. This relay never starts a task.

Delegated children execute in the destination FIFO after rechecking the admitted handoff, original conversation, grant and destination readiness. The destination must pass the existing linked Telegram bot, owner chat and process-readiness checks; failed checks record `not_ready` without invoking its Host. The Server selects a fresh OpenCode session outside the prompt, so the child receives only the explicit source brief plus its own configured agent instructions and cannot replace the saved owner conversation. Production children receive no application-tool capabilities, preventing further delegation. A queued or running child never holds the source agent turn open.

Startup and source-bot attachment recover terminal results that have no notification intent, with paginated source-scoped scans and fresh grant/origin checks. Existing intents are skipped, so interrupted delivery is never replayed. Missing source credentials or an unattached Telegram bot leave results pending for a later resume or attachment. Outcome recovery never starts an agent task.

The task service supports cancellation of a specific child: queued cancellation commits its outcome without stopping earlier target work, and running cancellation persists before aborting that child. Permission relays reject a cancellation-requested child; late success and restart recovery preserve cancellation. The requesting agent can see the cancellation request through its status tool.

Queued children pause during pending process actions and after recorded completed or interrupted stops; starting that target resumes its FIFO. Deleted-target reconciliation atomically fails only correlated queued children as `not_ready`, without loading target credentials or repeating running work. Prior results remain unchanged, and result delivery still requires a live grant and saved origin.

Authenticated panel APIs expose paginated delegation metadata and source-scoped cancellation, including queued children whose target cannot load. History omits parent prompts and child output; running cancellation uses the existing runner or the exact bound Host ID. Open **Delegations** from the source agent’s panel page to review handoffs and cancel a specific queued or running child.

### External MCP tools

The panel’s **MCP catalog** stores administrator-selected HTTPS definitions, pinned tool schemas and read/write classifications in Server SQLite. Integrations start with no agent grants. Open **Access** on an agent’s page and use **MCP integrations** to grant access and manage its bearer credential. Credentials live in private Server files, and the panel shows only whether one is configured. Changing the endpoint revokes existing grants and retires their credentials. The catalog’s **Test connection** lists remote tools from the Server. Administrators review schemas and save the tools they want to approve. The Server rejects invalid or unsupported schemas before saving; argument validation uses the approved schema without type conversion or inserted defaults. Missing tools or changed input schemas detected by the execution service are disabled in the catalog until explicitly reviewed. The panel identifies affected tools; saving unrelated settings preserves their blocks. Review the schema and access, confirm the tool’s review checkbox, then save to approve it again. Granted catalog tools are available to verified Telegram and Discord chat tasks through the bundled adapter. Scheduled, webhook and delegated tasks receive none. Each turn carries at most 23 catalog tools and 16 KiB of tool metadata, leaving room for memory and peer operations within the 32-operation limit.

Under **Examples**, the catalog includes public MCP servers for web search, weather, developer documentation, and more. Choose **Set up** to discover tools without credentials, review the tools you want to approve, and save the integration. Grant access from the agent’s **Access** page when it is ready to use.

MCP connections originate on the Server and use the saved HTTPS endpoint and the selected agent’s optional bearer credential. The administrator is trusted to choose endpoints. Remote servers receive MCP negotiation/session traffic, the selected tool name and its validated argument object. Writes ask the initiating owner for approval with a 30-second decision budget; the Approvals page uses `mcp.write` or `mcp.read` and the exact target `<definition ID>:<remote tool name>`. External tools do not qualify for persistent Always allow rules. Calls have a 30-second remote lifetime, four listing pages, a 128 KiB aggregate response budget and a 12 KiB result limit. Results redact the endpoint and configured bearer value. Ending a task cancels pending calls where supported; it cannot undo a remote side effect. Invocation intents are saved before execution, and saved or uncertain outcomes prevent a retry from repeating the same invocation.

### Agent memory

Each Host keeps explicit notes in `memory.sqlite` in its task-state directory: title, bounded content (4,000 characters), up to 10 tags, source task, timestamps, and an optional expiry, capped at 500 notes. Search is local SQLite FTS5 keyword and tag retrieval ranked by match and recency, returning at most 10 notes and 8,000 characters. Memory tools are scoped to that agent's notes, which are never copied from transcripts automatically; the agent reads them as untrusted context. The model can edit the file from its shell, so every read re-applies the limits, skips malformed rows, and rebuilds an inconsistent index. The panel's **Memory** page lists notes (paginated) and deletes them, which also removes their search entry; earlier chat transcripts and backups may still hold copies. The Server grants memory tools automatically to authorized Telegram and Discord chat tasks for every agent. Scheduled, webhook and delegated tasks receive no memory tools. `tests/memory-fts5.integration.test.ts` (part of the Docker suite) fails if the image loses FTS5.

## Agent lifecycle

The server verifies BotFather tokens with Telegram and rejects bots already linked to another agent. Tokens remain in private server-side files; SQLite holds credential references. Replacing a token must preserve the bot's identity and takes effect after restarting that agent. Switching an existing agent to a different bot is outside the current scope.

Agent names and instructions persist across restarts. Instructions are snapshotted as context for each new task; edits do not modify running work or the Telegram bot's profile. Names allow up to 128 characters and instructions up to 4000 characters.

Nimbot uses the agent ID to download a Bottts Neutral avatar from DiceBear and stores the image with the agent's data. The Dashboard uses initials while the avatar is unavailable. When Telegram or Discord starts, Nimbot applies the generated avatar if the bot has no profile photo. Existing profile photos are preserved, and an unsuccessful avatar sync does not interrupt the connection.

The Server saves the agent and its desired process state before starting its Agent
Host. Each agent gets distinct workspace, engine, task and browser directories
under `agents/<agent ID>/`, plus its own Host API credential. Hosts bind to
loopback and receive a minimal environment. Both deployment modes use the same
process lifecycle operations; neither requires access to the Docker daemon.

Deletion requires explicit confirmation and keeps agent data unless purge is
separately selected. If Telegram is connected, deletion stops polling and removes
the local Telegram chat binding and credentials. Remove a Discord connection from **Channels** before
deleting its agent. Deleting the Telegram bot identity is a separate action in BotFather.

Explicitly deleting agent data removes its workspace, OpenCode session history, and Host task state, including private memory and the tool outbox. Shared provider connections belong to the installation. Approval history, delegation records, peer notes, and the MCP catalog live in the separate Server database. Deleting an agent also revokes its MCP grants and retires its stored MCP credentials. Backups can still contain copies of deleted data.

## Tasks and recovery

Incoming messages and task state are committed before execution. Each agent has a persistent FIFO queue and runs one turn at a time across its conversations; duplicate Telegram updates are deduplicated by bot ID and update ID. Commands remain responsive during execution. Progress, approval buttons, and results stay in the originating agent's chat, and long answers are split to fit Telegram limits. Approval callbacks check the owner, agent, and task; unanswered or undeliverable approvals are denied.

`TASK_TIMEOUT_SECONDS` bounds execution (10–3600 seconds, default 600). Failed or cancelled tasks free the queue for the next message. Uncertain task submissions are never retried automatically. Transient reads and engine startup failures use bounded retries; a failed bot connection does not stop other bots.

The Agent Host saves its ordinary OpenCode conversation session ID in its task-state directory and loads it for later turns. Server-selected `sessionMode: "fresh"` metadata starts a separate conversation without reading or replacing that saved session, so an ordinary turn afterward resumes its prior history; the mode is persisted with the Host task, stays outside the prompt and does not enable tools. If a session cannot be loaded, it starts a new one. Running tasks become interrupted after a Host restart rather than being replayed. On server restart, saved agents reconnect with their existing owners and chat bindings, and unfinished operations are recorded as interrupted. The Server restores agents whose desired state was running; explicitly stopped agents remain stopped. Unexpected Host exits are reported and require an explicit start.

The Server resolves the agent and task from its running SQLite record and sends an `execution` object with `agentId` and `serverTaskId`, saved atomically with the Host task before execution and passed to the engine separately from the prompt. The Server saves the accepted Host ID before processing events; if it cannot save that association, it requests cancellation and does not retry submission. Both stores retain the association after restart. A repeated agent/Server-task pair cannot execute again. Prompt-only Host submissions remain supported and carry no execution identity. These fields only correlate records and grant no application tools.

The task service resolves tool operations from Server-owned policy. When a policy grants access, a short-lived capability travels separately in `tools`, and the Host passes a snapshot to the engine without persisting its token. The Server's internal dispatch guard binds each token to its agent, task, saved Host ID, original conversation, operations, and expiry, and rechecks current authorization. Cancellation, execution ending, service shutdown, and expiry revoke access; restarting cannot restore tokens. Scheduled tasks and webhooks never receive capabilities, even when a policy is configured.

For tool-enabled turns, the engine starts a bundled HTTP MCP adapter on loopback and registers it on new or restored ACP sessions. Only granted, Host-registered handlers are discoverable. Missing handlers, stale identity, or unsupported HTTP MCP fail before prompting. The adapter uses a separate per-turn credential, keeps task identity and capabilities out of model-visible tool arguments, bounds requests and responses to 64 KiB, and permits at most four concurrent calls and 100 calls per turn. Each call has a 60-second timeout capped by capability expiry. Ending the prompt or stopping the engine closes the endpoint and aborts pending calls; stopping also waits for adapter startup to settle before another turn can begin.

Host-registered Server tools use a durable outbox in the task database. Each invocation and its `tool_request` event are committed together before waiting for a result. Arguments and outcomes are limited to 16 KiB each, with four pending requests and 100 invocations per turn. Reusing an invocation ID with changed arguments is rejected; identical replays return the saved outcome without publishing another request. Authenticated Host endpoints report whether an invocation is still awaiting a result and accept a single immutable outcome. Cancellation and timeout emit `tool_cancel` events; a Host restart marks unresolved requests interrupted, and no old waiter is restored. Capability and Host API credentials are not included in these events. Server dispatch and write replay protection are implemented, and private memory handlers run locally in the Host; Host records are not trusted authorization or proof of a Server side effect. Server cancellation immediately aborts active tool calls without waiting for another Host poll and rejects later tool requests. The dispatcher stops waiting even if a handler ignores cancellation, aborts the handler scope on every exit, and never replaces a saved cancelled write outcome with a late result. It rechecks authorization immediately before entering a handler.

Terminal and filesystem tools run through OpenCode in the Agent Host process environment. Browser automation uses headless Chromium through terminal execution with the bundled Playwright tooling; no external browser service is required. Client-side ACP filesystem and terminal capabilities remain disabled.

Open **Executions** in the panel to see the queue and page through finished tasks.
The detail shows the saved request and available response text, even when the
Agent Host is stopped. An execution can finish successfully while its chat delivery
remains unconfirmed. Tasks recorded before delivery tracking show **Unknown** for
delivery. Older response text is available when the associated Host record still
exists.

## Persistence and diagnostics

Server state in `server.sqlite` includes agents, owners, instructions, verified bot identities, chat bindings, desired process state, the durable task queue, and schedules with their saved prompts, cadences, time zones, UTC next-run timestamps, and private webhook tokens. It retains the latest 20 run records per schedule and reads execution status from the associated task row. Private credential directories live alongside SQLite in `SERVER_STATE_DIR` (default `.nimbot-native/` for native development, `/data` in Docker). Each agent persists workspace files, browser profiles, and task records and results under `agents/<agent ID>/`. The installation-wide database under `ai-providers/` holds provider credentials and workspace-scoped OpenCode sessions. Docker stores the entire tree in one named data volume. Back up the complete tree and `.env`; backups contain secrets.

Manage API keys and device sign-ins from **AI providers** in the sidebar, even before creating an agent. OpenAI supports API keys and ChatGPT device sign-in, Anthropic, Google, and OpenRouter support API keys, and OpenCode Console uses device sign-in. OpenCode stores credentials and renews OAuth tokens in the installation-wide database. The panel displays connection status and device authorization instructions. All current and future agents use the saved connection. In **Model and usage**, choose a model for the agent or use **Automatic** to follow its OpenCode default. Nimbot validates API keys before saving. Failed validation or sign-in keeps the previous connection. Disconnecting removes the saved connection for all agents. The provider manages revocation.

Both applications expose health checks and emit structured JSON logs with agent and task IDs. Prompts and results are not logged, and credentials are redacted. `NIMBOT_LOG=silent` disables logging. The panel reports bot polling, owner chat linking, process status, and authenticated Host readiness separately; Host readiness checks workspace access and busy state. **AI provider status** shows separate checks for active credentials and when each result was recorded. Stopping or restarting an agent may interrupt active work. Interrupted tasks are not automatically replayed.

## Runtime configuration

The Server assigns each Host an available port on `127.0.0.1`. Hosts report their
bound ports over Node IPC and shut down if that connection is lost. Ports and
PIDs do not persist. The manager serializes lifecycle changes, detects unexpected
exits, stops process groups during shutdown, and restores running intent from
SQLite. An explicit stop remains stopped across a Server restart.

Each agent's workspace, tasks, home, engine data/configuration/cache/state,
temporary files and browser profile live under `<data directory>/agents/<agent ID>/`.
Hosts receive an explicit minimal environment, their own Host token and the
configured task timeout. Server secrets, provider keys and Node/OpenCode overrides
are not inherited. Host tokens remain in private files referenced by SQLite;
a missing or damaged saved token requires repair instead of silent rotation.
Agents can access these files through the installation’s shared OS account. See [Security limitations](OPERATIONS.md#security-limitations).

Chromium binaries can be shared with `PLAYWRIGHT_BROWSERS_PATH`. Browser calls
use each agent's assigned `AGENT_BROWSER_PROFILE_DIR`, preserving cookies and
local storage across calls and Host restarts. Run one browser probe at a time
per agent because Chromium locks its profile while in use.

For a directly invoked Host, `AGENT_HOST_BIND_ADDRESS` accepts an IPv4 or IPv6
address (default `0.0.0.0`), and `AGENT_HOST_PORT` accepts 0–65535 (default 3001).
The Server overrides these with loopback and port zero, allowing the OS to choose
the port. A fresh Server schema omits Docker lifecycle metadata and rejects
previous Server databases without modifying them. Registration commits bot
identity and initial process intent together. Removal stops the Host, removes its
schedules and connection credentials, and leaves a tombstone. Agent directories
remain unless purge is explicitly selected.

| Path | Responsibility |
|---|---|
| `apps/server/` | Panel API, Telegram, registry, routing, and process management |
| `apps/agent-host/` | AI engine, tasks, and persistent workspace per agent process |
| `apps/panel/` | Administration UI |
| `packages/` | Shared code when needed by multiple apps |
| `infrastructure/docker/` | Application image Dockerfile |
| `tests/` | Integration and panel end-to-end tests |
| `docs/` | Installation, operations, and technical reference |
