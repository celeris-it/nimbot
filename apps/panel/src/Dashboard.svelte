<script lang="ts">
  import type {
    AgentDetail,
    AgentDirectoryEntry,
    AgentSummary,
  } from "../../server/src/panel/panel-contracts.js";
  import {
    botLabel,
    botAccessLabels,
    discordConversationLabels,
    ownerLabels,
    processLabels,
  } from "./labels.js";
  import {
    ActionButton,
    AgentAvatar,
    EmptyState,
    FilterGroup,
    Icon,
    SearchField,
    StatusBadge,
    Surface,
    UsageChart,
    UsageDonut,
    UsageTrend,
    UsageRings,
  } from "./components/index.js";
  import { modelIcon } from "./components/model-brand.js";
  import { request } from "./api.js";
  import type { UsageOverview } from "../../server/src/providers/usage-contracts.js";

  let {
    agents,
    canCreate,
    refresh,
  }: {
    agents: AgentDirectoryEntry[];
    canCreate: boolean;
    refresh: () => void;
  } = $props();
  let filter = $state("all");
  let agentQuery = $state("");
  let selectedId = $state("");
  const attention = (item: AgentSummary) =>
    item.process?.state === "failed" ||
    item.botConnection?.status === "failed" ||
    item.botConnection?.status === "blocked";
  let configured = $derived(
    agents.filter((item) => item.process?.state === "running").length,
  );
  let range = $state("7");
  let overview = $state<UsageOverview>();
  let overviewFailed = $state(false);
  // Agent statuses refresh every few seconds, which also refreshes usage.
  $effect(() => {
    void agents;
    const days = range;
    const current = new AbortController();
    request<UsageOverview>(`/api/usage/overview?days=${days}`, {
      signal: current.signal,
    }).then(
      (value) => {
        overview = value;
        overviewFailed = false;
      },
      () => {
        if (!current.signal.aborted) overviewFailed = true;
      },
    );
    return () => current.abort();
  });
  const usd = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  const money = (value: number) =>
    value > 0 && value < 0.01 ? "< $0.01" : usd.format(value);
  const count = new Intl.NumberFormat(undefined, { notation: "compact" });
  const weekday = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
  const monthDay = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  let totalCost = $derived(
    overview?.days.reduce((sum, day) => sum + day.costUsd, 0) ?? 0,
  );
  let totalTokens = $derived(
    overview?.days.reduce((sum, day) => sum + day.tokens, 0) ?? 0,
  );
  let bars = $derived(
    (overview?.days ?? []).map((day) => {
      const date = new Date(`${day.day}T00:00:00Z`);
      return {
        key: day.day,
        label: (range === "7" ? weekday : monthDay).format(date),
        value: day.costUsd,
        title: `${monthDay.format(date)} (UTC): ${money(day.costUsd)}, ${count.format(day.tokens)} tokens, ${day.tasks} ${day.tasks === 1 ? "task" : "tasks"}`,
      };
    }),
  );
  let hourCurrent = $derived(
    (overview?.hourly ?? []).slice(24).map((hour) => hour.costUsd),
  );
  let hourPrevious = $derived(
    (overview?.hourly ?? []).slice(0, 24).map((hour) => hour.costUsd),
  );
  let hourTotal = $derived(hourCurrent.reduce((sum, value) => sum + value, 0));
  let hourBefore = $derived(
    hourPrevious.reduce((sum, value) => sum + value, 0),
  );
  let hourDelta = $derived(hourTotal - hourBefore);
  let deltaText = $derived(
    `${hourDelta >= 0 ? "+" : "−"}${money(Math.abs(hourDelta))}${
      hourBefore > 0
        ? ` (${Math.abs(Math.round((hourDelta / hourBefore) * 100))}%)`
        : ""
    }`,
  );
  let quotas = $derived((overview?.quotas ?? []).slice(0, 4));
  const resets = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const shown = 4;
  let modelRows = $derived.by(() => {
    const models = overview?.models ?? [];
    const rows = models.slice(0, shown).map((model) => ({
      key: `${model.providerId}/${model.modelId}`,
      label: model.modelId,
      icon: modelIcon(model),
      value: model.costUsd,
      tokens: model.tokens,
    }));
    const rest = models.slice(shown);
    if (rest.length)
      rows.push({
        key: "other",
        label: `${rest.length} other ${rest.length === 1 ? "model" : "models"}`,
        icon: "bot" as const,
        value: rest.reduce((sum, model) => sum + model.costUsd, 0),
        tokens: rest.reduce((sum, model) => sum + model.tokens, 0),
      });
    return rows;
  });
  // Cost is the share when any is reported; otherwise fall back to tokens.
  let byTokens = $derived(modelRows.every((row) => row.value === 0));
  let slices = $derived(
    modelRows.map((row) => ({
      key: row.key,
      value: byTokens ? row.tokens : row.value,
    })),
  );
  let shareTotal = $derived(slices.reduce((sum, item) => sum + item.value, 0));
  let needsAttention = $derived(agents.filter(attention).length);
  let filtered = $derived.by(() => {
    const query = agentQuery.trim().toLowerCase().replace(/^@/, "");
    return agents.filter((item) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "ready"
          ? item.process?.state === "running"
          : attention(item));
      const searchable = `${item.name} ${item.botUsername ?? ""} ${item.id}`;
      return matchesFilter && searchable.toLowerCase().includes(query);
    });
  });
  // Selection is a local preview only; it never changes Telegram routing.
  let selected = $derived(
    filtered.find((item) => item.id === selectedId) ?? filtered[0],
  );
  let discordFromDetails = $state<{
    agentId: string;
    discord: AgentDirectoryEntry["discord"];
  }>();
  let selectedDiscordDetails = $derived(
    discordFromDetails?.agentId === selected?.id
      ? discordFromDetails
      : undefined,
  );
  let previewDiscord = $derived(
    selected?.discord ??
      (selected?.optionCapabilities?.discord
        ? selectedDiscordDetails?.discord
        : undefined),
  );
  $effect(() => {
    const item = selected;
    // A running server may advertise Discord before its directory includes the summary.
    if (!item?.optionCapabilities?.discord || item.discord) return;
    const current = new AbortController();
    void request<AgentDetail>(`/api/agents/${encodeURIComponent(item.id)}`, {
      signal: current.signal,
    }).then(
      ({ discord }) => {
        if (!current.signal.aborted)
          discordFromDetails = {
            agentId: item.id,
            discord: discord?.connection
              ? discord
              : discord && { connection: null },
          };
      },
      () => {
        if (!current.signal.aborted)
          discordFromDetails = { agentId: item.id, discord: undefined };
      },
    );
    return () => current.abort();
  });
  const setupLabel = (item: AgentSummary) =>
    item.process ? processLabels[item.process.state] : "Unavailable";
</script>

<div data-ui="page-heading">
  <div>
    <span data-ui="eyebrow">OVERVIEW</span>
    <h1 tabindex="-1">Your agents.</h1>
  </div>
  <div data-ui="heading-actions">
    <ActionButton
      variant="ghost"
      iconOnly
      aria-label="Refresh status"
      onclick={refresh}><Icon name="refresh" /></ActionButton
    >{#if canCreate}<ActionButton
        variant="primary"
        href="/agents/new"
        icon="plus">Create agent</ActionButton
      >{/if}
  </div>
</div>

<div data-ui="overview-grid">
  <Surface
    title="Usage"
    description="Reported model cost per day across all agents (UTC)."
  >
    {#snippet actions()}<FilterGroup
        label="Usage range"
        bind:value={range}
        options={[
          { value: "7", label: "7 days" },
          { value: "30", label: "30 days" },
        ]}
      />{/snippet}
    {#if overviewFailed && !overview}
      <p data-ui="muted">Usage is unavailable right now.</p>
    {:else}
      <div data-ui="usage-totals">
        <strong>{money(totalCost)}</strong>
        <span
          >reported cost<small
            >{count.format(totalTokens)} tokens in the last {range} days</small
          ></span
        >
      </div>
      <UsageChart
        {bars}
        caption={`Reported cost per day for the last ${range} days`}
      />
      {#if overview?.missingCost}<p data-ui="muted">
          {overview.missingCost}
          {overview.missingCost === 1 ? "task has" : "tasks have"} no reported cost
          and {overview.missingCost === 1 ? "is" : "are"} counted as $0.
        </p>{/if}
    {/if}
  </Surface>
  <Surface
    title="Models"
    description={`Share of ${byTokens ? "tokens" : "cost"}.`}
  >
    {#if modelRows.length === 0}
      <p data-ui="muted">
        {overviewFailed
          ? "Usage is unavailable right now."
          : `No model usage in the last ${range} days.`}
      </p>
    {:else}
      <div data-ui="model-breakdown">
        <UsageDonut
          {slices}
          label={byTokens ? count.format(totalTokens) : money(totalCost)}
          detail={byTokens ? "tokens" : `last ${range} days`}
        />
        <ul>
          {#each modelRows as row, index (row.key)}
            <li data-slice={index}>
              <span data-ui="legend-name"
                ><i></i><Icon name={row.icon} size={14} /><span title={row.key}
                  >{row.label}</span
                ></span
              >
              <strong
                >{shareTotal
                  ? Math.round(
                      ((byTokens ? row.tokens : row.value) / shareTotal) * 100,
                    )
                  : 0}%</strong
              >
              <small
                >{byTokens
                  ? `${count.format(row.tokens)} tokens`
                  : money(row.value)}</small
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    <p data-ui="muted">
      Costs are the amounts reported by each provider after a task finishes.
      Tasks without a reported cost are counted as $0, and the model share falls
      back to tokens when no cost was reported.
    </p>
  </Surface>
</div>

<div data-ui="overview-grid" data-order="swapped">
  <Surface title="Quota left" description="Tightest limit per AI provider.">
    {#if quotas.length === 0}
      <p data-ui="muted">
        No provider quota data yet. It appears once an agent’s model reports its
        limits.
      </p>
    {:else}
      <div data-ui="model-breakdown">
        <UsageRings
          rings={quotas.map((item) => ({
            key: item.providerId,
            percent: item.remainingPercent,
          }))}
          label={`${quotas[0]!.remainingPercent}%`}
          detail="left"
        />
        <ul>
          {#each quotas as item, index (item.providerId)}
            <li data-slice={index}>
              <span data-ui="legend-name"
                ><i></i><span title={`${item.providerId} · ${item.window}`}
                  >{item.providerId}</span
                ></span
              >
              <strong>{item.remainingPercent}%</strong>
              <small
                title={`${item.window}, resets ${resets.format(item.resetsAt)}`}
                >{item.window}</small
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </Surface>
  <Surface
    title="Last 24 hours"
    description="Cumulative reported cost by hour, compared with the 24 hours before."
  >
    <div data-ui="trend-summary">
      <strong>{money(hourTotal)}</strong>
      {#if hourBefore > 0 || hourTotal > 0}<span
          data-ui="trend-delta"
          data-direction={hourDelta > 0
            ? "up"
            : hourDelta < 0
              ? "down"
              : "flat"}>{deltaText}</span
        >{/if}
      <small>vs {money(hourBefore)} in the previous 24 hours</small>
    </div>
    <UsageTrend
      current={hourCurrent}
      previous={hourPrevious}
      caption="Cumulative reported cost over the last 24 hours"
    />
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
    <SearchField
      label="Search agents"
      placeholder="Search agents"
      bind:value={agentQuery}
    />
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
      {#snippet actions()}<ActionButton
          onclick={() => {
            agentQuery = "";
            filter = "all";
          }}>Clear filters</ActionButton
        >{/snippet}
    </EmptyState>
  {:else}
    <div data-ui="fleet-layout">
      <div data-ui="agent-list" role="group" aria-label="Agent workspaces">
        {#each filtered as item (item.id)}
          {@const identifier = item.botUsername
            ? `@${item.botUsername}`
            : item.id}
          <ActionButton
            variant="plain"
            type="button"
            data-ui="agent-row"
            aria-label={`Select ${item.name}`}
            aria-describedby={`fleet-status-${encodeURIComponent(item.id)}`}
            aria-pressed={selected.id === item.id}
            onclick={() => (selectedId = item.id)}
          >
            <AgentAvatar agentId={item.id} name={item.name} small /><span
              ><strong title={item.name}>{item.name}</strong><small
                title={identifier}>{identifier}</small
              ></span
            ><StatusBadge
              id={`fleet-status-${encodeURIComponent(item.id)}`}
              label={setupLabel(item)}
              tone={attention(item)
                ? "warning"
                : item.process?.state === "running"
                  ? "good"
                  : "neutral"}
            /><Icon name="chevron" size={14} />
          </ActionButton>
        {/each}
      </div>
      <article data-ui="agent-preview" aria-label="Selected agent">
        <div data-ui="preview-top">
          <div data-ui="preview-identity">
            {#key selected.id}
              <AgentAvatar agentId={selected.id} name={selected.name} />
            {/key}
            <div>
              <h3>{selected.name}</h3>
              <p>
                {selected.botUsername
                  ? `@${selected.botUsername}`
                  : selected.id}
              </p>
            </div>
          </div>
          <ActionButton
            variant="primary"
            href={`/agents/${encodeURIComponent(selected.id)}/setup`}
            icon="chevron">Manage</ActionButton
          >
        </div>
        <div data-ui="preview-facts">
          <div class:col-span-full={!selected.botUsername}>
            <Icon name="telegram" /><span
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
            <div class="col-span-full">
              <Icon name="terminal" /><span
                >Bot link<strong
                  >{selected.setupAccess
                    ? botAccessLabels[selected.setupAccess.bot]
                    : "Unavailable"}</strong
                ></span
              >
            </div>{/if}
          {#if previewDiscord || selected.optionCapabilities?.discord}
            <div class:col-span-full={!previewDiscord?.conversation}>
              <Icon name="discord" /><span>
                Discord bot
                <strong
                  >{previewDiscord
                    ? (previewDiscord.connection?.botUsername ??
                      "Not configured")
                    : selectedDiscordDetails
                      ? "Status unavailable"
                      : "Loading…"}</strong
                >
                {#if previewDiscord?.conversation}
                  {discordConversationLabels[previewDiscord.conversation.state]}
                {/if}
              </span>
            </div>
            {#if previewDiscord?.conversation}
              <div>
                <Icon name="shield" /><span>
                  Discord owner DM
                  <strong
                    >{previewDiscord.conversation.ownerLinked
                      ? "Linked"
                      : "Waiting for the owner's first private message"}</strong
                  >
                </span>
              </div>
            {/if}
          {/if}
        </div>
        {#if selected.botUsername}
          <div data-ui="preview-actions">
            <ActionButton
              href={`https://t.me/${selected.botUsername}`}
              icon="arrow">Open chat in Telegram</ActionButton
            >
          </div>
        {/if}
      </article>
    </div>
  {/if}
</Surface>
<footer data-ui="dashboard-footer">
  <span
    ><Icon name="shield" size={14} /> Your server. Your agents. Your control.</span
  ><span>States refresh every 5 seconds while visible.</span>
</footer>
