# Recover agents on a replacement server

## Restore the backup

- [x] Update `docs/OPERATIONS.md` to document restoring onto a new Docker host. Use the same Nimbot version that created the backup, stop the source deployment before activating the destination, and restore the Server state and all three volumes for each agent.
- [x] Create the workspace, engine, and task volumes under their canonical names before extracting the archives. Apply the `io.nimbot.agent-id` and `io.nimbot.installation` labels using the agent ID and restored installation identity. Inspect existing volumes before extraction and abort on conflicts. Keep the current archive format and preserve file ownership.

## Rebuild agents from the panel

- [x] Add a **Recover on this server** action to the agent page and an authenticated, same-origin `POST /api/agents/:id/recover` endpoint. Offer recovery when Docker confirms the recorded container is missing. Explain what the administrator needs to fix when credentials or volumes are missing, labels do not match, Docker inspection fails, or resource names conflict. Resolve all resource names and references from Server state.
- [x] Verify all three restored volumes before mutating Docker. Reuse the provisioning template, pinned image, and saved Agent Host credential to create the private network, connect the Server, and create the agent container stopped. Save the new Docker references while preserving the agent ID, credentials, chat bindings, schedules, and task history.
- [x] Persist the recovery state and resource creation intents before Docker mutations. Serialize recovery with start, stop, provisioning, and deletion. After a crash or lost Docker response, use read-only inspection to reconcile resources attributable to the saved recovery attempt. Leave conflicting resources and restored volumes intact.
- [x] Check for missing containers before resuming agent work on startup. Hold queued work for affected agents throughout recovery. Once the administrator selects **Start** and the authenticated Agent Host responds, resume polling and the existing queue. Preserve the current rules for interrupted tasks and missed schedules.

## Verify recovery

- [x] Add a Docker integration test that restores a backed-up agent with new container and network IDs. Verify preservation of workspace files, engine and task state, owner binding, and queued work. Confirm the recreated container stays stopped until **Start**.
- [x] Test a missing volume, mismatched labels, a conflicting container name, concurrent recovery requests, and restart after a lost Docker response. Verify these paths preserve the volumes and prevent premature task execution.
- [ ] Update the README and run `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`, including the opt-in Docker recovery test.
