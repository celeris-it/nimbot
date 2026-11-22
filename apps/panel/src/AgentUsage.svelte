<script lang="ts">
  import { DataTable, StatusBadge } from "./components/index.js";
  import type {
    AgentModels,
    AgentUsage,
    ModelReference,
    QuotaStatus,
  } from "../../server/src/providers/usage-contracts.js";

  let {
    agent,
    catalog,
    data,
    before,
    busy,
    save,
    refresh,
  }: {
    agent: { id: string; name: string };
    catalog: AgentModels | undefined;
    data: AgentUsage | undefined;
    before: number | undefined;
    busy: boolean;
    save: (model: ModelReference | null) => Promise<void>;
    refresh: () => void;
  } = $props();

  let base = $derived(`/agents/${encodeURIComponent(agent.id)}`);
  let selected = $derived(catalog?.selected ?? null);
  const key = (model: ModelReference) =>
    JSON.stringify([model.providerId, model.modelId]);
  let savedValue = $derived(selected ? key(selected) : "automatic");
  let selection = $derived(savedValue);
  let listed = $derived(
    !selected || catalog?.models.some((model) => key(model) === key(selected!)),
  );
  const number = new Intl.NumberFormat();
  const usd = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  const money = (value: number | null) =>
    value === null
      ? "Unavailable"
      : value > 0 && value < 0.000001
        ? "< $0.000001"
        : usd.format(value);
  const time = (timestamp: number) => new Date(timestamp).toLocaleString();
  const quotaText = {
    available: "Quota available",
    unavailable: "Quota unavailable",
    exhausted: "Queue paused for quota",
    checking: "Waiting for a quota check",
    model_unavailable: "Queue paused because the model is unavailable",
  };
  const failureText: Record<NonNullable<QuotaStatus["failure"]>, string> = {
    host_unavailable:
      "The Agent Host could not return its model status. Check the Host on the agent setup page.",
    opencode_missing:
      "OpenCode was not found on the Agent Host’s PATH. Install the version required by Nimbot and restart Nimbot.",
    opencode_start_failed:
      "OpenCode exited before it could serve models. Check that Nimbot is using OpenCode 2.2.7, then restart Nimbot.",
    opencode_start_timeout:
      "OpenCode did not become ready in time. Check the OpenCode installation and restart the agent.",
    opencode_check_failed:
      "OpenCode could not check the model or quota. Check the AI provider connection and model settings.",
    quota_check_failed:
      "OpenCode did not return quota data for the connected account. Check the OpenCode Console connection.",
  };
  const origins: Record<string, string> = {
    telegram: "Telegram",
    discord: "Discord",
    delegated: "Delegation",
    schedule: "Schedule",
    webhook: "Webhook",
  };

  const historyColumns = [
    { label: "Started" },
    { label: "Status" },
    { label: "Origin" },
    { label: "Model" },
    { label: "Tokens", numeric: true },
    { label: "Reported cost (USD)", numeric: true },
  ];
  const historyDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  });
  const historyTime = new Intl.DateTimeFormat(undefined, {
    timeStyle: "medium",
  });
  const historyStatus: Record<
    string,
    { label: string; tone: "neutral" | "good" | "warning" | "danger" }
  > = {
    completed: { label: "Completed", tone: "good" },
    failed: { label: "Failed", tone: "danger" },
    interrupted: { label: "Interrupted", tone: "warning" },
    cancelled: { label: "Cancelled", tone: "neutral" },
    running: { label: "Running", tone: "neutral" },
    queued: { label: "Queued", tone: "neutral" },
  };

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const value = new FormData(form).get("model");
    if (value === "automatic") void save(null);
    else {
      const model = catalog?.models.find((entry) => key(entry) === value);
      if (model)
        void save({ providerId: model.providerId, modelId: model.modelId });
    }
  }
</script>

<h1 tabindex="-1">Model and usage for {agent.name}</h1>
<nav class="actions" aria-label="Agent actions">
  <a class="panel-button" href={`${base}/setup`}>Back to agent</a>
  <a class="panel-button" href="/providers">AI providers</a>
  <button class="panel-button" onclick={refresh} disabled={busy}>Refresh</button
  >
</nav>

<section class="panel-card" aria-labelledby="model-heading">
  <h2 id="model-heading">Model</h2>
  {#if catalog}
    <form onsubmit={submit} aria-busy={busy}>
      <label for="agent-model">Model for new turns</label>
      <select
        class="panel-select"
        id="agent-model"
        name="model"
        bind:value={selection}
        disabled={busy}
      >
        <option value="automatic">Automatic</option>
        {#if selected && !listed}
          <option value={key(selected)} disabled
            >{selected.providerId}/{selected.modelId} (unavailable)</option
          >
        {/if}
        {#each catalog.models as model (key(model))}
          <option value={key(model)}
            >{model.name} ({model.providerId}/{model.modelId})</option
          >
        {/each}
      </select>
      <button
        class="panel-button panel-button-primary"
        type="submit"
        disabled={busy}>Save model</button
      >
    </form>
    {#if !catalog.catalogAvailable}
      <p role="status">Model catalog unavailable.</p>
    {/if}
  {:else}
    <p role="status">Model settings unavailable.</p>
  {/if}
</section>

<section class="panel-card" aria-labelledby="quota-heading">
  <h2 id="quota-heading">OpenCode quota</h2>
  {#if data?.quota}
    {@const quota = data.quota}
    <p>
      <strong
        >{quota.failure
          ? "Model or quota check failed"
          : quotaText[quota.state]}</strong
      >
      {#if quota.model}
        · {quota.model.providerId}/{quota.model.modelId}{/if}
    </p>
    {#if quota.failure}
      <p role="status">{failureText[quota.failure]}</p>
    {/if}
    {#if data.queued}<p>{number.format(data.queued)} queued</p>{/if}
    <p>Last checked {time(quota.checkedAt)}</p>
    {#if quota.windows.length}
      <ul class="windows">
        {#each quota.windows as window (window)}
          <li>
            <strong>{window.name}</strong>
            · {number.format(Math.round(window.usedPercent * 10) / 10)}% used
            {#if window.spentUsd !== undefined && window.limitUsd !== undefined}
              · {money(window.spentUsd)} of {money(window.limitUsd)}
            {/if}
            {#if window.exhausted}
              · Limit reached{/if}
            · Resets {time(window.resetsAt)}
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <p role="status">Waiting for the first quota check.</p>
  {/if}
</section>

<section aria-labelledby="usage-heading">
  <h2 id="usage-heading">Usage</h2>
  {#if data}
    <div class="totals">
      {#each [{ name: "Today (UTC)", value: data.today }, { name: "This month (UTC)", value: data.month }] as total (total.name)}
        <div class="panel-card">
          <h3>{total.name}</h3>
          <dl>
            <div>
              <dt>Tokens</dt>
              <dd>{number.format(total.value.tokens)}</dd>
            </div>
            <div>
              <dt>Reported cost (USD)</dt>
              <dd>{total.value.tasks ? money(total.value.costUsd) : "—"}</dd>
            </div>
            <div>
              <dt>Tasks</dt>
              <dd>{number.format(total.value.tasks)}</dd>
            </div>
          </dl>
          {#if total.value.incomplete || total.value.missingCost}
            <p>
              {number.format(total.value.incomplete)} with incomplete usage · {number.format(
                total.value.missingCost,
              )} without cost
            </p>
          {/if}
        </div>
      {/each}
    </div>
    {#snippet historyPages()}
      <nav class="actions" aria-label="Usage history pages">
        {#if before}<a class="panel-button" href={`${base}/usage`}
            >Newest tasks</a
          >{/if}
        {#if data?.next}<a
            class="panel-button"
            href={`${base}/usage?before=${data.next}`}>Older tasks</a
          >{/if}
      </nav>
    {/snippet}
    <DataTable
      caption="Task usage history"
      columns={historyColumns}
      rows={data.tasks}
      rowKey={(task) => task.id}
      empty="No model tasks on this page."
      footer={before || data.next ? historyPages : undefined}
    >
      {#snippet row(task)}
        {@const usage = task.usage}
        {@const status = historyStatus[task.status]}
        <td>
          <time
            class="whitespace-nowrap tabular-nums"
            datetime={new Date(task.startedAt).toISOString()}
          >
            <span class="font-semibold"
              >{historyDate.format(task.startedAt)}</span
            >
            <small class="history-detail"
              >{historyTime.format(task.startedAt)}</small
            >
          </time>
        </td>
        <td>
          <StatusBadge
            label={status?.label ?? task.status}
            tone={status?.tone}
          />
          {#if usage?.state === "partial"}<small class="history-detail"
              >Partial usage</small
            >{/if}
        </td>
        <td class="usage-origin">
          {origins[task.origin] ?? task.origin}
          {#if task.scheduleName}<small class="history-detail wrap-anywhere"
              >{task.scheduleName}</small
            >{/if}
        </td>
        <td class="usage-model">
          {#if usage}
            <span class="model-id">{usage.model.modelId}</span>
            <small class="history-detail model-id"
              >{usage.model.providerId}</small
            >
          {:else}
            <span class="text-muted">Unavailable</span>
          {/if}
        </td>
        <td data-numeric>
          {#if usage?.tokens}
            <span class="font-semibold"
              >{number.format(
                Object.values(usage.tokens).reduce(
                  (sum, value) => sum + value,
                  0,
                ),
              )}</span
            >
            <small class="history-detail">
              In {number.format(usage.tokens.input)} · Out {number.format(
                usage.tokens.output,
              )}
            </small>
          {:else}
            <span class="text-muted">Unavailable</span>
          {/if}
        </td>
        <td data-numeric>
          <span class={usage?.costUsd == null ? "text-muted" : "font-semibold"}>
            {money(usage?.costUsd ?? null)}
          </span>
        </td>
      {/snippet}
    </DataTable>
  {:else}
    <p role="status">Usage history unavailable. Refresh to try again.</p>
  {/if}
</section>

<style>
  .actions,
  form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }
  section {
    margin-block: 1rem;
  }
  .totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: 0.75rem;
  }
  .history-detail {
    display: block;
    margin-top: 0.2rem;
    color: var(--color-muted);
    font-size: 0.75rem;
  }
  .usage-origin {
    min-width: 10rem;
  }
  .usage-model {
    min-width: 16rem;
  }
  .model-id {
    font-family: var(--font-mono);
    word-break: break-all;
  }
  .windows {
    margin: 0;
    padding-left: 1.25rem;
    list-style: disc;
  }
  dl {
    display: grid;
    gap: 0.4rem;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  dd {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    margin: 0;
  }
</style>
