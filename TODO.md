# TODO: shared agent runner and Docker deployment

Simplify development and deployment by replacing per-agent containers with
one shared runner per Nimbot installation. Deliver the native development
path first, then the recommended Docker deployment in the next milestone.

## Decisions

- Each agent runs in a separate Agent Host process. The panel manages agent
  creation, start, stop, restart, and removal within the installation.
- An installation is a single trust domain for its agents. Agents share an
  OS account and can read or modify each other's workspaces, memory, and
  provider credentials. Users who need separation deploy another Nimbot
  installation with its own runner and data.
- Defer per-agent Unix users and resource-limit configuration. Docker Compose
  is optional.
- This release starts with a fresh installation. No migration or import from
  previous releases is in scope. Existing data stays on disk until an
  administrator removes it explicitly.

## First milestone: native development

- [ ] Add a pnpm entry point that starts the Server, panel, and shared runner
      without Docker. Document the Node.js, OpenCode, and Chromium
      prerequisites. Bind the development panel and Agent Hosts to loopback.
- [ ] Give each Agent Host a configurable listen address and port. Assign
      each agent separate workspace, engine state, task state, and browser
      profile directories under the installation's data directory.
      Progress: listener address and port are configurable through
      `AGENT_HOST_BIND_ADDRESS` and `AGENT_HOST_PORT`, with validated values.
      Runner-assigned ports and per-agent directory allocation remain pending.
- [ ] Implement runner lifecycle operations for creating, starting, stopping,
      restarting, and removing Agent Host processes. Persist desired state
      so a runner restart restores agents that were meant to be running.
- [ ] Keep one Host API token per agent. Define the Server-to-runner control
      channel and how deployment modes keep Server credentials and runner
      control access out of agent processes. Agent-to-agent trust does not
      extend to Server-side credentials or authorization.
- [ ] Route panel lifecycle and status actions through the runner. Explain
      the shared trust model in the panel and clearly identify native
      development mode.
- [ ] Keep agent data on removal unless the administrator explicitly purges
      it. Use a fresh Server schema for runner-managed agents.
- [ ] Verify native setup from a clean checkout, panel lifecycle operations,
      restart recovery, and concurrent OpenCode and browser sessions using
      distinct state directories.

## Second milestone: Docker deployment

- [ ] Package the same Server and runner for a documented Docker CLI
      installation. Run all agents as processes in one runner container
      per installation, with persistent data and no Docker socket mount.
- [ ] Expose only the panel. Keep runner control and Agent Host endpoints
      internal and run agents as non-root.
- [ ] Remove the per-agent Docker provisioning, reconciliation, and panel
      controls once both paths use the shared runner.
- [ ] Replace Compose-dependent install and operations steps with Docker CLI
      instructions. Review install, uninstall, and release scripts for
      assumptions about per-agent containers, volumes, and networks.
- [ ] Verify a clean Docker installation without Compose, panel lifecycle
      operations, and data persistence across container recreation.

## Documentation

- [ ] Update README.md and AGENTS.md alongside implementation to describe
      the new architecture, native development mode, and trust model.
- [ ] Update docs/INSTALL.md and docs/OPERATIONS.md with setup, backups,
      recovery, and the fresh-install requirement.
