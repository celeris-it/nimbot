<script lang="ts">
  import type { AgentSummary } from "../../server/src/panel-contracts.js";
  import { botLabel, botAccessLabels, ownerLabels } from "./labels.js";
  import {
    ActionButton,
    AgentAvatar,
    EmptyState,
    FilterGroup,
    Icon,
    Metric,
    ProgressMeter,
    SearchField,
    StatusBadge,
    Surface,
  } from "./components/index.js";

  let {
    agents,
    canCreate,
    refresh,
  }: { agents: AgentSummary[]; canCreate: boolean; refresh: () => void } =
    $props();
  let query = $state("");
  let filter = $state("all");
  let selectedId = $state("");
  const attention = (item: AgentSummary) =>
    ["failed", "interrupted", "cancelled"].includes(item.provisioning) ||
    item.botConnection?.status === "failed" ||
    item.botConnection?.status === "blocked";
  let configured = $derived(
    agents.filter((item) => item.provisioning === "ready").length,
  );
  let connected = $derived(
    agents.filter((item) => item.botConnection?.status === "polling").length,
  );
  let needsAttention = $derived(agents.filter(attention).length);
  let filtered = $derived(
    agents.filter((item) => {
      const matches = `${item.name} ${item.botUsername ?? ""} ${item.id}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
      return (
        matches &&
        (filter === "all" ||
          (filter === "ready"
            ? item.provisioning === "ready"
            : attention(item)))
      );
    }),
  );
  // Selection is a local preview only; it never changes Telegram routing.
  let selected = $derived(
    filtered.find((item) => item.id === selectedId) ?? filtered[0],
  );
  const setupLabel = (item: AgentSummary) =>
    item.provisioning === "ready"
      ? "Configured"
      : item.provisioning === "provisioning"
        ? "Setting up"
        : item.provisioning.charAt(0).toUpperCase() +
          item.provisioning.slice(1);
</script>

<div data-ui="page-heading">
  <div>
    <span data-ui="eyebrow">YOUR WORKSPACE, ALWAYS ON</span>
    <h1 tabindex="-1">Your agents.</h1>
  </div>
  <div data-ui="heading-actions">
    <button
      class="btn btn-circle btn-ghost"
      aria-label="Refresh status"
      onclick={refresh}><Icon name="refresh" /></button
    >{#if canCreate}<ActionButton primary href="/agents/new" icon="plus"
        >Create agent</ActionButton
      >{/if}
  </div>
</div>

<div data-ui="overview-grid">
  <Surface
    title="At a glance"
    description="A little space for everything you're building."
  >
    {#snippet actions()}<span data-ui="icon-disc"
        ><Icon name="grid" size={17} /></span
      >{/snippet}
    <div class="stats" aria-label="Agent overview">
      <Metric
        label="Total agents"
        value={agents.length.toString().padStart(2, "0")}
        description="Independent workspaces"
      />
      <Metric
        label="Configured"
        value={configured.toString().padStart(2, "0")}
        description="Setup completed"
      />
      <Metric
        label="Needs attention"
        value={needsAttention.toString().padStart(2, "0")}
        description="Setup or bot issues"
      />
    </div>
    <div data-ui="overview-footer">
      <div class="avatar-group">
        {#each agents.slice(0, 4) as item (item.id)}<AgentAvatar
            name={item.name}
            small
          />{/each}
      </div>
      <p>
        {agents.length
          ? "One agent. One bot. Its own space."
          : "Your next idea starts with an agent."}
      </p>
      {#if canCreate}<a
          class="btn btn-circle btn-ghost"
          href="/agents/new"
          aria-label="Add a workspace"><Icon name="arrow" size={16} /></a
        >{/if}
    </div>
  </Surface>
  <Surface title="Telegram connections">
    {#snippet actions()}<Icon name="bot" size={20} />{/snippet}
    <div data-ui="connection-total">
      <strong>{connected.toString().padStart(2, "0")}</strong><span
        >bots polling<small>of {agents.length} registered</small></span
      ><span data-ui="connection-symbol"
        ><Icon name="activity" size={28} /></span
      >
    </div>
    <ProgressMeter
      label="Bot connections"
      value={connected}
      max={agents.length}
    />
    <p data-ui="muted">
      Owners activate their private chat with /start. Polling alone does not
      confirm task availability.
    </p>
  </Surface>
</div>

<div data-ui="workspace-toolbar">
  <div>
    <Icon name="grid" size={16} /><strong>Your fleet</strong><span class="badge"
      >{agents.length}</span
    >
  </div>
  <SearchField
    label="Search agents"
    placeholder="Find an agent…"
    bind:value={query}
  />
</div>

<Surface tone="muted">
  <div data-ui="workspace-heading">
    <h2>
      Agent workspaces <span>{filtered.length.toString().padStart(2, "0")}</span
      >
    </h2>
    <FilterGroup
      label="Filter agents"
      bind:value={filter}
      options={[
        { value: "all", label: "All agents", count: agents.length },
        { value: "ready", label: "Configured", count: configured },
        { value: "attention", label: "Needs attention", count: needsAttention },
      ]}
    />
  </div>
  {#if agents.length === 0}
    <EmptyState
      title="A workspace for your next idea."
      description={canCreate
        ? "No agents yet. Create your first agent."
        : "No agents yet. Configure server provisioning to create agents from the panel."}
    />
  {:else if !selected}
    <EmptyState
      title="No matching agents."
      description="Try another name, bot username, or filter."
      icon="search"
    >
      {#snippet actions()}<button
          class="btn"
          onclick={() => {
            query = "";
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
                >{item.botUsername
                  ? `@${item.botUsername}`
                  : "Bot link pending"}</small
              ></span
            ><StatusBadge
              label={setupLabel(item)}
              tone={attention(item) ? "warning" : "neutral"}
            /><Icon name="chevron" size={14} />
          </button>
        {/each}
      </div>
      <article
        data-ui="agent-preview"
        data-theme="nimbot"
        aria-label="Selected agent"
      >
        <div data-ui="preview-top">
          <span data-ui="eyebrow">AGENT WORKSPACE</span><StatusBadge
            label={setupLabel(selected)}
            tone={attention(selected)
              ? "warning"
              : selected.provisioning === "ready"
                ? "good"
                : "neutral"}
          />
        </div>
        <div data-ui="preview-identity">
          <AgentAvatar name={selected.name} />
          <div>
            <h3>{selected.name}</h3>
            <p>
              {selected.botUsername
                ? `@${selected.botUsername}`
                : "Telegram bot not linked yet"}
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
          <div>
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
          </div>
        </div>
        <div data-ui="preview-actions">
          <p>One Telegram bot per agent. Every conversation in its place.</p>
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
