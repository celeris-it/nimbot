# TODO: agent subprocesses and Docker deployment

Simplify development and deployment by replacing per-agent containers with
Agent Host subprocesses managed directly by the Nimbot Server. Nimbot runs
as one application under one OS account. Deliver the native development
path first, then the recommended Docker deployment in the next milestone.

## Decisions

- The Server starts each agent as a separate Agent Host child process. There
  is no separate runner service and no Server-to-runner control channel. The
  panel manages agent creation, start, stop, restart, and removal.
- An installation is a single trust domain that includes the Server and all
  of its agents. Everything runs under one OS account. Agents can read or
  modify each other's workspaces, memory, and provider credentials, and can
  also reach Server state: bot tokens, MCP credentials, Host secrets, and
  `server.sqlite`. Users who need separation deploy another Nimbot
  installation with its own data.
- Server-side approvals, grants, and rules govern normal agent behaviour.
  They are not a security boundary against an agent with shell access. A
  prompt-injected agent could read Server secrets or change Server state.
  Document this risk wherever the trust model is explained.
- No separate OS accounts for the Server and agents, and no per-agent Unix
  users. Defer resource-limit configuration. Docker Compose is optional.
- Keep low-cost hygiene that does not add setup steps: start Agent Hosts
  with an explicit minimal environment instead of the Server's, keep one
  Host API token per agent, bind Agent Hosts to loopback, and keep secrets
  out of model context, task events, and logs.
- This release starts with a fresh installation. No migration or import from
  previous releases is in scope. Existing data stays on disk until an
  administrator removes it explicitly.

## First milestone: native development

- [x] Add a pnpm entry point that starts the Server and panel without
      Docker; the Server starts the Agent Hosts. Document the Node.js,
      OpenCode, and Chromium prerequisites. Bind the development panel and
      Agent Hosts to loopback.
- [x] Give each Agent Host a configurable listen address and port. Assign
      each agent separate workspace, engine state, task state, and browser
      profile directories under the installation's data directory.
- [x] Implement Server-side process lifecycle operations for creating,
      starting, stopping, restarting, and removing Agent Host processes.
      Persist desired state so a Server restart restores agents that were
      meant to be running. Detect unexpected process exits and stop child
      processes when the Server shuts down.
- [x] Start each Agent Host with an explicit minimal environment and its own
      Host API token. Do not pass Server configuration or secrets through
      the environment or arguments.
- [x] Route panel lifecycle and status actions through the process manager.
      Explain the shared trust model in the panel, including agent access
      to Server secrets, and clearly identify native development mode.
- [x] Keep agent data on removal unless the administrator explicitly purges
      it. Use a fresh Server schema for process-managed agents.
- [x] Verify native setup from a clean checkout, panel lifecycle operations,
      restart recovery, and concurrent OpenCode and browser sessions using
      distinct state directories.
      Verification: CI and an opt-in test run the compiled Server with real Hosts,
      authenticated API creation/start/stop/removal, retained workspace data,
      stopped-state retention and running-state recovery after Server restarts.
      Telegram transport is simulated. Chromium tests cover native panel lifecycle
      controls, confirmations, shared-trust guidance and narrow-screen layouts.
      A real Chromium gate verifies concurrent agent profiles and retained cookies
      and local storage across separate CLI invocations. Browser instructions now
      use the native installation path instead of a fixed Docker path.
      The pinned OpenCode gate runs two real engines concurrently, checks distinct
      data directories and session IDs, and verifies separate histories after Host
      restarts. A clean temporary checkout passed frozen dependency installation,
      build, and all three native gates (Server, OpenCode and Chromium).

## Second milestone: Docker deployment

- [ ] Package the same application for a documented Docker CLI
      installation: one container per installation running the Server and
      its Agent Host subprocesses as non-root, with persistent data and no
      Docker socket mount.
- [ ] Expose only the panel. Keep Agent Host endpoints on container
      loopback.
- [ ] Remove the per-agent Docker provisioning, reconciliation, and panel
      controls once both paths use Agent Host subprocesses.
- [ ] Replace Compose-dependent install and operations steps with Docker CLI
      instructions. Review install, uninstall, and release scripts for
      assumptions about per-agent containers, volumes, and networks.
- [ ] Verify a clean Docker installation without Compose, panel lifecycle
      operations, and data persistence across container recreation.

## Documentation

- [ ] Update README.md alongside implementation to describe the new
      architecture, native development mode, and trust model, including the
      Security section's statements about agent isolation and Server
      credentials. Finish aligning AGENTS.md once the per-agent container
      code is removed.
- [ ] Update docs/INSTALL.md and docs/OPERATIONS.md with setup, backups,
      recovery, and the fresh-install requirement.
