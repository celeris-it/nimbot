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

- [ ] Add a pnpm entry point that starts the Server and panel without
      Docker; the Server starts the Agent Hosts. Document the Node.js,
      OpenCode, and Chromium prerequisites. Bind the development panel and
      Agent Hosts to loopback.
- [ ] Give each Agent Host a configurable listen address and port. Assign
      each agent separate workspace, engine state, task state, and browser
      profile directories under the installation's data directory.
      Progress: listener configuration and subprocess directory/environment
      preparation are implemented and tested. Connecting directory allocation
      to Server lifecycle operations and browser profiles remains pending.
- [ ] Implement Server-side process lifecycle operations for creating,
      starting, stopping, restarting, and removing Agent Host processes.
      Persist desired state so a Server restart restores agents that were
      meant to be running. Detect unexpected process exits and stop child
      processes when the Server shuts down.
      Progress: subprocess manager implements start/stop/restart/removal, OS-assigned
      loopback ports, exit detection, process-group cleanup, startup cancellation,
      and restoration through a SQLite desired-state store. Real-process tests
      cover restoration after reopening the database. Server entrypoint and panel
      integration remain pending.
- [ ] Start each Agent Host with an explicit minimal environment and its own
      Host API token. Do not pass Server configuration or secrets through
      the environment or arguments.
      Progress: subprocess configuration builds an explicit minimal environment
      with per-agent state paths, a supplied Host token, and loopback binding.
      Private per-agent tokens now persist through a credential store with atomic
      reference claiming and no silent rotation of missing or damaged files.
      Server lifecycle integration remains pending.
- [ ] Route panel lifecycle and status actions through the process manager.
      Explain the shared trust model in the panel, including agent access
      to Server secrets, and clearly identify native development mode.
- [ ] Keep agent data on removal unless the administrator explicitly purges
      it. Use a fresh Server schema for process-managed agents.
      Progress: the new versioned subprocess Server schema omits Docker metadata
      and rejects previous Server databases without modifying them. The process
      manager retains agent directories unless purge is explicitly requested;
      wiring registration and deletion into the Server remains pending.
- [ ] Verify native setup from a clean checkout, panel lifecycle operations,
      restart recovery, and concurrent OpenCode and browser sessions using
      distinct state directories.

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
