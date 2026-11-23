<script lang="ts">
  import {
    formattingLocale,
    messages,
    numberFormat,
    pluralRules,
  } from "./i18n/language.js";
  import type {
    AgentDirectoryEntry,
    AgentSummary,
  } from "../../server/src/panel/panel-contracts.js";
  import { processLabels } from "./labels.js";
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
  const telegramIssue = (item: AgentSummary) =>
    item.botConnection?.status === "blocked"
      ? $messages("Telegram blocked")
      : item.botConnection?.status === "failed"
        ? $messages("Telegram connection failed")
        : undefined;
  const attention = (item: AgentSummary) =>
    item.process?.state === "failed" || Boolean(telegramIssue(item));
  let configured = $derived(
    agents.filter((item) => item.process?.state === "running").length,
  );
  let range = $state("30");
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
  const usd = $derived(
    new Intl.NumberFormat($formattingLocale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }),
  );
  const money = (value: number) =>
    value > 0 && value < 0.01 ? `< ${usd.format(0.01)}` : usd.format(value);
  const count = $derived(
    new Intl.NumberFormat($formattingLocale, { notation: "compact" }),
  );
  const weekday = $derived(
    new Intl.DateTimeFormat($formattingLocale, {
      weekday: "short",
      timeZone: "UTC",
    }),
  );
  const monthDay = $derived(
    new Intl.DateTimeFormat($formattingLocale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
  );
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
        title: $messages(
          "{0} (UTC): {1}, {2} tokens, {3}",
          monthDay.format(date),
          money(day.costUsd),
          count.format(day.tokens),
          $messages(
            $pluralRules.select(day.tasks) === "one" ? "{0} task" : "{0} tasks",
            $numberFormat.format(day.tasks),
          ),
        ),
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
  const quotaRingCount = 4;
  let quotas = $derived(
    (overview?.quotas ?? []).map((item) => ({
      ...item,
      key: JSON.stringify([item.providerId, item.window]),
    })),
  );
  const resets = $derived(
    new Intl.DateTimeFormat($formattingLocale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  );
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
        label: $messages(
          $pluralRules.select(rest.length) === "one"
            ? "{0} other model"
            : "{0} other models",
          $numberFormat.format(rest.length),
        ),
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
  const processLabel = (item: AgentSummary) =>
    item.process
      ? $messages(processLabels[item.process.state])
      : $messages("Unavailable");
</script>

<div data-ui="page-heading">
  <h1 tabindex="-1">{$messages("Your agents.")}</h1>
  <div data-ui="heading-actions">
    <ActionButton
      variant="ghost"
      iconOnly
      aria-label={$messages("Refresh status")}
      onclick={refresh}><Icon name="refresh" /></ActionButton
    >{#if canCreate}<ActionButton
        variant="primary"
        href="/agents/new"
        icon="plus">{$messages("Create agent")}</ActionButton
      >{/if}
  </div>
</div>

<Surface tone="muted">
  <div data-ui="workspace-heading">
    <SearchField
      label={$messages("Search agents")}
      placeholder={$messages("Search agents")}
      bind:value={agentQuery}
    />
    <FilterGroup
      label={$messages("Filter agents")}
      bind:value={filter}
      options={[
        { value: "all", label: $messages("All agents"), count: agents.length },
        {
          value: "ready",
          label: $messages("Running"),
          count: configured,
        },
        {
          value: "attention",
          label: $messages("Needs attention"),
          count: needsAttention,
        },
      ]}
    />
  </div>
  {#if agents.length === 0}
    <EmptyState
      title={$messages("A workspace for your next idea.")}
      description={canCreate
        ? $messages("No agents yet. Create your first agent.")
        : $messages("No agents yet. Agent creation is unavailable.")}
    />
  {:else if filtered.length === 0}
    <EmptyState
      title={$messages("No matching agents.")}
      description={$messages("Try another name, bot username, or filter.")}
      icon="search"
    >
      {#snippet actions()}<ActionButton
          onclick={() => {
            agentQuery = "";
            filter = "all";
          }}>{$messages("Clear filters")}</ActionButton
        >{/snippet}
    </EmptyState>
  {:else}
    <ul data-ui="agent-grid" aria-label={$messages("Agent workspaces")}>
      {#each filtered as item (item.id)}
        {@const id = encodeURIComponent(item.id)}
        {@const editable = item.optionCapabilities?.edit}
        {@const issue = telegramIssue(item)}
        {@const statusId = `fleet-status-${id}`}
        {@const handleId = `fleet-handle-${id}`}
        <li>
          <ActionButton
            variant="plain"
            href={`/agents/${id}/${editable ? "settings" : "setup"}`}
            data-ui="agent-profile"
            aria-label={$messages(
              editable ? "Open {0} settings" : "Open {0} overview",
              item.name,
            )}
            aria-describedby={item.botUsername
              ? `${statusId} ${handleId}`
              : statusId}
          >
            <AgentAvatar agentId={item.id} name={item.name} />
            <span data-ui="agent-profile-identity">
              <strong title={item.name}>{item.name}</strong>
              {#if item.botUsername}
                <small id={handleId} title={`@${item.botUsername}`}>
                  @{item.botUsername}
                </small>
              {/if}
            </span>
            <span id={statusId} data-ui="agent-profile-status">
              <StatusBadge
                label={processLabel(item)}
                tone={item.process?.state === "failed"
                  ? "warning"
                  : item.process?.state === "running"
                    ? "good"
                    : "neutral"}
              />
              {#if issue}<StatusBadge label={issue} tone="warning" />{/if}
            </span>
            <span data-ui="agent-profile-destination">
              {editable ? $messages("Settings") : $messages("Overview")}
              <Icon name="chevron" size={16} />
            </span>
          </ActionButton>
        </li>
      {/each}
    </ul>
  {/if}
</Surface>

<div data-ui="overview-grid">
  <Surface
    title={$messages("Usage")}
    description={$messages(
      "Reported model cost per day across all agents (UTC).",
    )}
  >
    {#snippet actions()}<FilterGroup
        label={$messages("Usage range")}
        bind:value={range}
        options={[
          { value: "7", label: $messages("7 days") },
          { value: "30", label: $messages("30 days") },
        ]}
      />{/snippet}
    {#if overviewFailed && !overview}
      <p data-ui="muted">{$messages("Usage is unavailable right now.")}</p>
    {:else}
      <div data-ui="usage-totals">
        <strong>{money(totalCost)}</strong>
        <span
          >{$messages("reported cost")}<small
            >{$messages(
              "{0} tokens in the last {1} days",
              count.format(totalTokens),
              range,
            )}</small
          ></span
        >
      </div>
      <UsageChart
        {bars}
        caption={$messages(
          "Reported cost per day for the last {0} days",
          range,
        )}
      />
      {#if overview?.missingCost}<p data-ui="muted">
          {$messages(
            $pluralRules.select(overview.missingCost) === "one"
              ? "{0} task has no reported cost and is counted as $0."
              : "{0} tasks have no reported cost and are counted as $0.",
            $numberFormat.format(overview.missingCost),
          )}
        </p>{/if}
    {/if}
  </Surface>
  <Surface
    title={$messages("Models")}
    description={$messages(byTokens ? "Share of tokens." : "Share of cost.")}
  >
    {#if modelRows.length === 0}
      <p data-ui="muted">
        {overviewFailed
          ? $messages("Usage is unavailable right now.")
          : $messages("No model usage in the last {0} days.", range)}
      </p>
    {:else}
      <div data-ui="model-breakdown">
        <UsageDonut
          {slices}
          label={byTokens ? count.format(totalTokens) : money(totalCost)}
          detail={byTokens
            ? $messages("tokens")
            : $messages("last {0} days", range)}
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
                  ? $messages("{0} tokens", count.format(row.tokens))
                  : money(row.value)}</small
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    <p data-ui="muted">
      {$messages(
        "Costs are the amounts reported by each provider after a task finishes. Tasks without a reported cost are counted as $0, and the model share falls back to tokens when no cost was reported.",
      )}
    </p>
  </Surface>
</div>

<div data-ui="overview-grid" data-order="swapped">
  <Surface
    title={$messages("Quota left")}
    description={$messages("Remaining allowance by quota window.")}
  >
    {#if quotas.length === 0}
      <p data-ui="muted">
        {$messages(
          "No provider quota data yet. It appears once an agent’s model reports its limits.",
        )}
      </p>
    {:else}
      <div data-ui="model-breakdown">
        <UsageRings
          rings={quotas.slice(0, quotaRingCount).map((item) => ({
            key: item.key,
            percent: item.remainingPercent,
          }))}
          label={`${quotas[0]!.remainingPercent}%`}
          detail={$messages(quotas.length === 1 ? "left" : "lowest left")}
        />
        <ul>
          {#each quotas as item, index (item.key)}
            <li data-slice={index < quotaRingCount ? index : undefined}>
              <span data-ui="legend-name"
                ><i aria-hidden="true"></i><span
                  title={`${item.providerId} · ${item.window}`}
                  >{item.providerId}</span
                ></span
              >
              <strong>{item.remainingPercent}%</strong>
              <small
                title={$messages(
                  "{0}, resets {1}",
                  item.window,
                  resets.format(item.resetsAt),
                )}>{item.window}</small
              >
            </li>
          {/each}
        </ul>
      </div>
      {#if quotas.length > quotaRingCount}
        <p data-ui="muted">
          {$messages("Rings show the four lowest remaining quotas.")}
        </p>
      {/if}
    {/if}
  </Surface>
  <Surface
    title={$messages("Last 24 hours")}
    description={$messages(
      "Cumulative reported cost by hour, compared with the 24 hours before.",
    )}
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
      <small
        >{$messages("vs")}
        {money(hourBefore)}
        {$messages("in the previous 24 hours")}</small
      >
    </div>
    <UsageTrend
      current={hourCurrent}
      previous={hourPrevious}
      caption="Cumulative reported cost over the last 24 hours"
    />
  </Surface>
</div>
<footer data-ui="dashboard-footer">
  <span
    ><Icon name="shield" size={14} />
    {$messages("Your server. Your agents. Your control.")}</span
  ><span>{$messages("States refresh every 5 seconds while visible.")}</span>
</footer>
