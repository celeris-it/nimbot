# TODO: shared agent container and no-Docker development mode

Goal: stop creating one Docker container per agent. All agents run as separate
processes inside one shared runner container. A no-Docker mode runs the same
processes directly on the host, for development only.

## Open decisions

- [ ] Confirm the trust model: agents in one runner can read each other's
      workspace, provider credentials, and memory. Decide whether per-agent
      Unix users inside the runner are required for the first version.
- [ ] Decide whether the current per-agent container mode is removed or kept.
      Keeping it means maintaining all current provisioning code.
- [ ] Decide how a user separates agents: extra runner services declared in
      `compose.yaml` (the server needs no Docker socket) or runners created
      from the panel (the server keeps the socket).
- [ ] Decide whether resource limits apply per runner only or per agent.

## Agent Host

- [ ] Make the listen address and port configurable in
      `apps/agent-host/src/serve.ts` (today `0.0.0.0:3001`).
- [ ] Give each agent process its own workspace, state directory, and OpenCode
      data directory under one root, for example `/agents/<id>/`.
- [ ] Verify that two OpenCode instances run side by side without sharing
      configuration, sessions, or credentials.
- [ ] Verify that the browser tool works with several agents in one container
      (separate profiles, no port conflicts).

## Runner

- [ ] Add a runner entrypoint that starts, stops, and restarts one Agent Host
      process per agent and reports their state.
- [ ] Define the Server-to-runner control API (create, start, stop, remove
      agent process) with its own credential.
- [ ] Keep one Host API token per agent.
- [ ] Persist the runner's agent list so processes come back after a restart.
- [ ] Removing an agent must keep its data directory unless the user purges it.

## Server

- [ ] Put process lifecycle behind one interface with two implementations:
      runner container and local process.
- [ ] Replace per-agent container, network, and volume creation
      (`container-resources.ts`, `agent-provisioning.ts`,
      `container-control.ts`) with calls to that interface.
- [ ] Derive each agent's Host URL from runner address and assigned port.
- [ ] Remove or reduce code that only exists for per-agent Docker resources:
      `docker-api.ts`, `docker-preflight.ts`, `resource-reconciliation.ts`,
      `agent-resource-removal.ts`, and the container parts of agent recovery.
- [ ] Update panel pages that show container status, restart, recreate, and
      resource inventory.

## Compose and installation

- [ ] Add the runner service to `compose.yaml` with one data volume and the
      current hardening (non-root, dropped capabilities, `no-new-privileges`,
      CPU, memory, and process limits, no published ports).
- [ ] Remove the Docker socket mount, `group_add`, `DOCKER_SOCKET_PATH`, and
      `AGENT_HOST_IMAGE` from the server service if runners are static.
- [ ] Update `install.sh`, `upgrade.sh`, `uninstall.sh`, and
      `scripts/upgrade-docker.mjs` for the new resource set.
- [ ] Publish prebuilt images so installation pulls instead of building.

## Migration

- [ ] Add a versioned server schema migration (`server-v3.sql`) for the new
      agent location fields and the retired `container_ref`, `volume_ref`,
      and `network_ref`.
- [ ] Copy each agent's three volumes into the runner volume during upgrade,
      and keep the old volumes until the user removes them.
- [ ] Update `scripts/restore-agent-volumes.mjs` and the replacement-server
      procedure for the new layout.
- [ ] Set the supported predecessor in `release.json`.

## No-Docker development mode

- [ ] Add the local-process implementation: the Server spawns Agent Host
      processes on the host, bound to `127.0.0.1`.
- [ ] Enable it only through an explicit environment variable that the
      installer and `compose.yaml` never set.
- [ ] Refuse to start in this mode unless `PANEL_URL` is a localhost origin.
- [ ] Log a startup warning and show a panel banner stating that agents run
      without isolation.
- [ ] Add a `pnpm` script that starts the Server in this mode and document
      the host prerequisites (Node.js, OpenCode, Chromium).
- [ ] Store agent data under `SERVER_STATE_DIR`, never in the user's home.

## Tests

- [ ] Unit tests for the lifecycle interface and both implementations.
- [ ] Rewrite the Docker integration tests for the runner: lifecycle,
      isolation between agents, restart recovery, hardening, upgrade.
- [ ] Add a test that production configuration cannot enable no-Docker mode.
- [ ] Add an upgrade test that moves data from per-agent volumes.

## Documentation

- [ ] Update `README.md`: architecture, security model, provisioning, tests.
- [ ] Update `AGENTS.md`: the per-agent container rule and the rule against
      running agent commands on the host need a development-mode exception.
- [ ] Update `docs/INSTALL.md` and `docs/OPERATIONS.md`.
