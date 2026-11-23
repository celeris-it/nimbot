<script lang="ts">
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
  import { providers } from "../../server/src/providers/provider-contracts.js";
  import { Icon } from "./components/index.js";
  import { processLabels } from "./labels.js";
  let {
    agent,
    busy,
    action,
    refresh,
  }: {
    agent: AgentDetail;
    busy: boolean;
    action: (kind: "start") => Promise<void>;
    refresh: () => void;
  } = $props();
  const providerLabels = {
    available: "Available",
    rejected: "Reconnect required",
    restricted: "Access restricted",
    rate_limited: "Rate limited",
    unavailable: "Unavailable",
    unverified: "Unverified",
    not_configured: "Not configured",
  };
  let base = $derived(`/agents/${encodeURIComponent(agent.id)}`);
  let available = $derived(
    agent.hostState
      ? agent.hostState === "ready" || agent.hostState === "busy"
      : false,
  );
  let processMessage = $derived(
    agent.process?.state === "starting"
      ? "The Agent Host is starting. Wait for the operation to finish."
      : agent.process?.state === "stopping"
        ? "The Agent Host is stopping. Wait for the operation to finish."
        : available
          ? "The Agent Host is available."
          : agent.process?.state === "running"
            ? "The process is running, but its Host API is unavailable. Refresh status or restart the agent."
            : "The agent is saved. Start the Agent Host to make it available.",
  );
</script>

<h1 class="sr-only" tabindex="-1">{agent.name}</h1>
<a class="panel-button" href={`${base}/channels`}>
  <Icon name="link" size={16} />Manage channels
</a>
<div class="settings-section-list" data-ui="agent-overview">
  <section aria-labelledby="agent-host-heading">
    <div class="settings-section-description">
      <h2 id="agent-host-heading" class="card-title">
        <Icon name="server" size={20} />{agent.process
          ? `Agent Host ${processLabels[agent.process.state].toLowerCase()}.`
          : "Agent Host unavailable."}
      </h2>
      <p>{processMessage}</p>
    </div>
    <div class="panel-card">
      <dl>
        {#if agent.process}
          <dt>Process</dt>
          <dd>{processLabels[agent.process.state]}</dd>
        {/if}
        {#if agent.hostState}
          <dt>Host API</dt>
          <dd>
            {{ ready: "Available", busy: "Busy", unavailable: "Offline" }[
              agent.hostState
            ]}
          </dd>
        {/if}
        {#if agent.process}
          <dt>After a Server restart</dt>
          <dd>
            {agent.process.desiredState === "running"
              ? "Restore this agent’s Host"
              : "Leave this agent stopped"}
          </dd>
        {/if}
        <dt>Identifier</dt>
        <dd>{agent.id}</dd>
      </dl>
      <div class="button-row">
        {#if agent.process && agent.capabilities.process?.start}<button
            class="panel-button panel-button-primary"
            disabled={busy}
            onclick={() => action("start")}
            ><Icon name="play" size={16} />{busy
              ? "Starting…"
              : "Start agent"}</button
          >{/if}
        {#if agent.process && agent.capabilities.process?.stop}<a
            class="panel-button panel-button-danger"
            href={`${base}/process/stop`}
            ><Icon name="stop" size={16} />Stop agent…</a
          >{/if}
        {#if agent.process && agent.capabilities.process?.restart}<a
            class="panel-button panel-button-warning"
            href={`${base}/process/restart`}
            ><Icon name="restart" size={16} />Restart agent…</a
          >{/if}
        <button class="panel-button panel-button-info" onclick={refresh}
          ><Icon name="refresh" size={16} />Refresh status</button
        >
      </div>
    </div>
  </section>
  {#if agent.providerChecks}
    <section aria-labelledby="ai-provider-status">
      <div class="settings-section-description">
        <h2 id="ai-provider-status" class="card-title">
          <Icon name="cpu" size={20} />AI provider status
        </h2>
      </div>
      <div class="panel-card">
        {#if agent.providerChecks.length}
          <dl>
            {#each agent.providerChecks as check (check.id)}
              <dt>
                {providers.find((provider) => provider.id === check.id)?.name}
              </dt>
              <dd>
                {providerLabels[check.state]}
                ·
                <time datetime={new Date(check.checkedAt).toISOString()}>
                  {new Date(check.checkedAt).toLocaleString()}
                </time>
              </dd>
            {/each}
          </dl>
        {:else}
          <p>
            {agent.hostState === "unavailable"
              ? "Agent Host is offline."
              : "No provider check results yet."}
          </p>
        {/if}
      </div>
    </section>
  {/if}
  {#if agent.capabilities.delete}
    <section aria-label="Danger zone" data-tone="danger">
      <div class="settings-section-description">
        <h2 class="card-title">
          <Icon name="alert" size={20} />Danger zone
        </h2>
        <p>
          Deleting an agent stops its Host. Its data is kept unless you choose
          to delete it on the next page.
        </p>
      </div>
      <div class="panel-card" data-tone="danger">
        <a class="panel-button panel-button-danger" href={`${base}/delete`}
          ><Icon name="trash" size={16} />Delete agent…</a
        >
      </div>
    </section>
  {/if}
</div>
