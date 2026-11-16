<script lang="ts">
  import type { AgentDetail } from "../../server/src/panel-contracts.js";
  import DiscordSettings from "./DiscordSettings.svelte";
  import {
    botLabel,
    setupLabels,
    failureLabels,
    botAccessLabels,
    ownerLabels,
    stopMessage,
  } from "./labels.js";
  let {
    agent,
    busy,
    action,
    refresh,
    discordAction,
  }: {
    agent: AgentDetail;
    busy: boolean;
    action: (kind: "start" | "cancel" | "retry") => Promise<void>;
    refresh: () => void;
    discordAction: (
      kind: "save" | "remove",
      fields: Record<string, string>,
    ) => Promise<void>;
  } = $props();
  const operationLabels = {
    pending: "In progress",
    completed: "Completed",
    failed: "Failed",
    interrupted: "Interrupted by a server restart",
  };
  let base = $derived(`/agents/${encodeURIComponent(agent.id)}`);
  let available = $derived(
    agent.hostState
      ? agent.hostState === "ready" || agent.hostState === "busy"
      : agent.provisioning === "ready",
  );
</script>

<h1 tabindex="-1">{agent.name}</h1>
{#if agent.capabilities.edit}<a class="btn" href={`${base}/settings`}
    >Edit agent</a
  >{/if}
{#if agent.capabilities.replaceToken}<a class="btn" href={`${base}/token`}
    >Replace bot token</a
  >{/if}
<section class="card" aria-label="Creation result">
  <h2>
    {agent.containerState === "stopped"
      ? "Container stopped."
      : available
        ? "Container available."
        : "Agent offline."}
  </h2>
  <p>
    {available
      ? "The agent and its bot were saved and the container is available."
      : "The agent and its bot were saved, but the container is not available yet. Do not create the same agent again."}
  </p>
  <p>
    Setup: {agent.provisioning === "provisioning" && agent.cancellationRequested
      ? "Cancellation requested; waiting for the current operation to finish"
      : (setupLabels[agent.provisioning] ?? "Unknown state")}.
  </p>
  {#if agent.capabilities.cancel}
    <p>
      Cancelling stops the remaining setup steps. Created resources are kept; a
      container that already started may keep running.
    </p>
    <button class="btn" disabled={busy} onclick={() => action("cancel")}
      >Cancel setup</button
    >
  {/if}
  {#if agent.capabilities.retry}
    <p>
      Setup did not finish. Retrying keeps every resource already created and
      does not duplicate the agent.
    </p>
    <button class="btn" disabled={busy} onclick={() => action("retry")}
      >Retry setup</button
    >
  {/if}
  {#if agent.containerState}<p>
      Container: {{
        running: "Running",
        stopped: "Stopped",
        missing: "Not found",
        unavailable: "Unavailable",
      }[agent.containerState]}
    </p>{/if}
  {#if agent.hostState}<p>
      Agent Host: {{ ready: "Available", busy: "Busy", unavailable: "Offline" }[
        agent.hostState
      ]}
    </p>{/if}
  {#if agent.containerOperation}
    <p>
      Last operation: {agent.containerOperation.action === "start"
        ? "Start"
        : "Stop"} — {operationLabels[agent.containerOperation.status]}.
    </p>
    {#if agent.containerOperation.action === "stop" && !agent.stopObservation}<p
      >
        An active task may be interrupted. Its result will be confirmed when the
        agent is available again.
      </p>{/if}
  {/if}
  {#if agent.setupAccess}
    <dl>
      <dt>Bot link</dt>
      <dd>{botAccessLabels[agent.setupAccess.bot]}</dd>
      <dt>Owner verification</dt>
      <dd>{ownerLabels[agent.setupAccess.owner]}</dd>
    </dl>
  {/if}
  {#if agent.stopObservation}
    <section aria-label="Task at the last stop">
      <h2>Task at the last stop</h2>
      <p>{stopMessage(agent.stopObservation)}</p>
      <p>
        Pre-stop check: {new Date(
          agent.stopObservation.observedAt,
        ).toISOString()}.
      </p>
    </section>
  {/if}
  {#if agent.capabilities.container}
    <button class="btn" disabled={busy} onclick={() => action("start")}
      >Start container</button
    >
    <a class="btn" href={`${base}/container/stop`}>Stop container…</a>
  {/if}
  <dl>
    <dt>Identifier</dt>
    <dd>{agent.id}</dd>
    <dt>Bot</dt>
    <dd>{agent.botUsername ? `@${agent.botUsername}` : "Pending"}</dd>
  </dl>
  <p>Telegram bot: {botLabel(agent)}.</p>
  {#if agent.botConnection?.failure}<p>
      {failureLabels[agent.botConnection.failure]}
    </p>{/if}
  {#if agent.botConnection?.status === "polling"}<p>
      The owner’s first private message links this bot automatically. Tasks
      require completed setup and an available Agent Host.
    </p>{/if}
  {#if !agent.botConnection}<p>
      Connecting this bot to Telegram is still pending. It cannot receive tasks
      yet.
    </p>{/if}
  <button class="btn" onclick={refresh}>Refresh status</button>
  {#if agent.capabilities.delete}<a class="btn" href={`${base}/delete`}
      >Delete agent…</a
    >{/if}
  <a class="btn" href="/">Back to panel</a>
</section>

{#if agent.discord}
  {#key agent.id}<DiscordSettings {agent} {busy} action={discordAction} />{/key}
{/if}
