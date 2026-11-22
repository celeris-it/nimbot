<script lang="ts">
  import type { AgentSummary } from "../../server/src/panel/panel-contracts.js";
  import {
    botLabel,
    botAccessLabels,
    ownerLabels,
    processLabels,
  } from "./labels.js";
  import {
    ActionButton,
    AgentAvatar,
    EmptyState,
    FilterGroup,
    Icon,
    Metric,
    ProgressMeter,
    StatusBadge,
    Surface,
  } from "./components/index.js";

  let {
    agents,
    matchingAgents,
    clearSearch,
    canCreate,
    refresh,
  }: {
    agents: AgentSummary[];
    matchingAgents: AgentSummary[];
    clearSearch: () => void;
    canCreate: boolean;
    refresh: () => void;
  } = $props();
  let filter = $state("all");
  let selectedId = $state("");
  const attention = (item: AgentSummary) =>
    item.process?.state === "failed" ||
    item.botConnection?.status === "failed" ||
    item.botConnection?.status === "blocked";
  let configured = $derived(
    agents.filter((item) => item.process?.state === "running").length,
  );
  let connected = $derived(
    agents.filter((item) => item.botConnection?.status === "polling").length,
  );
  let telegramBots = $derived(agents.filter((item) => item.botUsername).length);
  let needsAttention = $derived(agents.filter(attention).length);
  let filtered = $derived(
    matchingAgents.filter(
      (item) =>
        filter === "all" ||
        (filter === "ready"
          ? item.process?.state === "running"
          : attention(item)),
    ),
  );
  // Selection is a local preview only; it never changes Telegram routing.
  let selected = $derived(
    filtered.find((item) => item.id === selectedId) ?? filtered[0],
  );
  const setupLabel = (item: AgentSummary) =>
    item.process ? processLabels[item.process.state] : "Unavailable";
</script>

<div data-ui="page-heading">
  <div>
    <span data-ui="eyebrow">OVERVIEW</span>
    <h1 tabindex="-1">Your agents.</h1>
  </div>
  <div data-ui="heading-actions">
    <button
      class="panel-button panel-button-icon panel-button-ghost"
      aria-label="Refresh status"
      onclick={refresh}><Icon name="refresh" /></button
    >{#if canCreate}<ActionButton primary href="/agents/new" icon="plus"
        >Create agent</ActionButton
      >{/if}
  </div>
</div>

<div data-ui="overview-grid">
  <Surface title="At a glance" description="Agent Hosts and bot connections.">
    {#snippet actions()}<span data-ui="icon-disc"
        ><Icon name="grid" size={17} /></span
      >{/snippet}
    <div class="metrics" aria-label="Agent overview">
      <Metric
        label="Total agents"
        value={agents.length}
        description="Independent workspaces"
      />
      <Metric
        label="Running"
        value={configured}
        description="Agent Hosts running"
      />
      <Metric
        label="Needs attention"
        value={needsAttention}
        description="Failed Host or bot connection"
      />
    </div>
    <div data-ui="overview-footer">
      <div class="agent-avatar-group">
        {#each agents.slice(0, 4) as item (item.id)}<AgentAvatar
            name={item.name}
            small
          />{/each}
      </div>
      <p>
        {agents.length
          ? `${agents.length} ${agents.length === 1 ? "workspace" : "workspaces"}`
          : "No agents yet."}
      </p>
      {#if canCreate}<a
          class="panel-button panel-button-icon panel-button-ghost"
          href="/agents/new"
          aria-label="Add a workspace"><Icon name="arrow" size={16} /></a
        >{/if}
    </div>
  </Surface>
  <Surface title="Telegram bots">
    {#snippet actions()}<Icon name="bot" size={20} />{/snippet}
    <div data-ui="connection-total">
      <strong>{connected}</strong><span
        >bots polling<small>of {telegramBots} registered</small></span
      ><span data-ui="connection-symbol"
        ><Icon name="activity" size={28} /></span
      >
    </div>
    <ProgressMeter
      label="Bot connections"
      value={connected}
      max={telegramBots}
    />
    <p data-ui="muted">
      Bots are polled by the Server even while an Agent Host is stopped, so this
      count can be higher than Running. The owner’s first private message links
      their chat. Discord connections are shown on each agent’s page.
    </p>
  </Surface>
</div>

<div data-ui="workspace-toolbar">
  <div>
    <Icon name="grid" size={16} /><strong>Your fleet</strong><span
      class="panel-badge">{agents.length}</span
    >
  </div>
</div>

<Surface tone="muted">
  <div data-ui="workspace-heading">
    <h2>
      Agent workspaces <span>{filtered.length}</span>
    </h2>
    <FilterGroup
      label="Filter agents"
      bind:value={filter}
      options={[
        { value: "all", label: "All agents", count: agents.length },
        {
          value: "ready",
          label: "Running",
          count: configured,
        },
        { value: "attention", label: "Needs attention", count: needsAttention },
      ]}
    />
  </div>
  {#if agents.length === 0}
    <EmptyState
      title="A workspace for your next idea."
      description={canCreate
        ? "No agents yet. Create your first agent."
        : "No agents yet. Agent creation is unavailable."}
    />
  {:else if !selected}
    <EmptyState
      title="No matching agents."
      description="Try another name, bot username, or filter."
      icon="search"
    >
      {#snippet actions()}<button
          class="panel-button"
          onclick={() => {
            clearSearch();
            filter = "all";
          }}>Clear filters</button
        >{/snippet}
    </EmptyState>
  {:else}
    <div data-ui="fleet-layout">
      <div data-ui="agent-list" role="group" aria-label="Agent workspaces">
        {#each filtered as item (item.id)}
          <button
            type="button"
            data-ui="agent-row"
            aria-label={`Select ${item.name}`}
            aria-pressed={selected.id === item.id}
            onclick={() => (selectedId = item.id)}
          >
            <AgentAvatar name={item.name} small /><span
              ><strong>{item.name}</strong><small
                >{item.botUsername ? `@${item.botUsername}` : item.id}</small
              ></span
            ><StatusBadge
              label={setupLabel(item)}
              tone={attention(item) ? "warning" : "neutral"}
            /><Icon name="chevron" size={14} />
          </button>
        {/each}
      </div>
      <article data-ui="agent-preview" aria-label="Selected agent">
        <div data-ui="preview-top">
          <span data-ui="eyebrow">AGENT WORKSPACE</span><StatusBadge
            label={setupLabel(selected)}
            tone={attention(selected)
              ? "warning"
              : selected.process?.state === "running"
                ? "good"
                : "neutral"}
          />
        </div>
        <div data-ui="preview-identity">
          <AgentAvatar name={selected.name} />
          <div>
            <h3>{selected.name}</h3>
            <p>
              {selected.botUsername ? `@${selected.botUsername}` : selected.id}
            </p>
          </div>
          <Icon name="bot" size={34} />
        </div>
        <div data-ui="preview-facts">
          <div>
            <Icon name="activity" /><span
              >Telegram bot<strong>{botLabel(selected)}</strong></span
            >
          </div>
          {#if selected.botUsername}<div>
              <Icon name="shield" /><span
                >Owner verification<strong
                  >{selected.setupAccess
                    ? ownerLabels[selected.setupAccess.owner]
                    : "Unavailable"}</strong
                ></span
              >
            </div>
            <div>
              <Icon name="terminal" /><span
                >Bot link<strong
                  >{selected.setupAccess
                    ? botAccessLabels[selected.setupAccess.bot]
                    : "Unavailable"}</strong
                ></span
              >
            </div>{/if}
        </div>
        <div data-ui="preview-actions">
          <div>
            {#if selected.botUsername}<ActionButton
                href={`https://t.me/${selected.botUsername}`}
                icon="arrow">Open chat in Telegram</ActionButton
              >{/if}<ActionButton
              href={`/agents/${encodeURIComponent(selected.id)}/setup`}
              icon="chevron">Manage</ActionButton
            >
          </div>
        </div>
      </article>
    </div>
  {/if}
</Surface>
<footer data-ui="dashboard-footer">
  <span
    ><Icon name="shield" size={14} /> Your server. Your agents. Your control.</span
  ><span>States refresh every 5 seconds while visible.</span>
</footer>
