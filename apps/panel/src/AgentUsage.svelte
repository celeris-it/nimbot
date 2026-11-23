<script lang="ts">
  import { Icon, DataTable, StatusBadge } from "./components/index.js";
  import ModelPicker from "./components/ModelPicker.svelte";
  import Select from "./components/Select.svelte";
  import type {
    AgentModels,
    AgentUsage,
    ModelSelection,
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
    save: (model: ModelSelection | null) => Promise<void>;
    refresh: () => void;
  } = $props();

  let base = $derived(`/agents/${encodeURIComponent(agent.id)}`);
  let selected = $derived(catalog?.selected);
  let selectedModel = $derived(
    catalog?.models.find(
      (model) =>
        model.providerId === selected?.providerId &&
        model.modelId === selected.modelId,
    ),
  );
  let selectedEffort = $derived(selected?.effort ?? "");
  let effortValue = $derived(selectedEffort);
  let efforts = $derived(selectedModel?.efforts ?? []);
  let missingEffort = $derived(
    !!catalog?.catalogAvailable &&
      !!selectedEffort &&
      !efforts.includes(selectedEffort),
  );
  const effortLabel = (value: string) =>
    value
      .replace(/[_-]/g, " ")
      .replace(/(^| )\S/g, (letter) => letter.toUpperCase());

  async function changeEffort(
    event: Event & { currentTarget: HTMLSelectElement },
  ) {
    if (!selectedModel) return;
    const effort = event.currentTarget.value;
    const { providerId, modelId } = selectedModel;
    await save(
      effort ? { providerId, modelId, effort } : { providerId, modelId },
    );
    effortValue = selectedEffort;
  }
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
    effort_unavailable:
      "Queue paused because the reasoning effort is unavailable",
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
</script>

<h1 tabindex="-1">Model and usage for {agent.name}</h1>
<nav class="actions" aria-label="Agent actions">
  <a class="panel-button" href={`${base}/setup`}>Back to agent</a>
  <a class="panel-button" href="/providers">AI providers</a>
  <button class="panel-button" onclick={refresh} disabled={busy}>Refresh</button
  >
</nav>

<div class="settings-section-list">
  <section aria-labelledby="model-heading">
    <div class="settings-section-description">
      <h2 id="model-heading" class="card-title">
        <Icon name="cpu" size={20} />Model
      </h2>
    </div>
    <div class="panel-card">
      {#if catalog}
        <ModelPicker
          models={catalog.models}
          value={catalog.selected}
          disabled={busy}
          onchange={save}
        />
        {#if efforts.length || selectedEffort}
          <div class="effort-field">
            <label for="model-effort">Reasoning effort</label>
            <Select
              id="model-effort"
              bind:value={effortValue}
              disabled={busy || !selectedModel || !catalog.catalogAvailable}
              aria-describedby={missingEffort
                ? "model-effort-status"
                : undefined}
              onchange={changeEffort}
            >
              <option value="">Default</option>
              {#if selectedEffort && !efforts.includes(selectedEffort)}
                <option value={selectedEffort} disabled>
                  {effortLabel(selectedEffort)}{missingEffort
                    ? " (Unavailable)"
                    : ""}
                </option>
              {/if}
              {#each efforts as effort (effort)}
                <option value={effort}>{effortLabel(effort)}</option>
              {/each}
            </Select>
            {#if missingEffort}
              <p id="model-effort-status" role="status">
                {selectedModel
                  ? "Choose another reasoning effort or Default to resume the queue."
                  : "Choose an available model or Automatic to resume the queue."}
              </p>
            {/if}
          </div>
        {/if}
        {#if busy}<p role="status">Saving model settings…</p>{/if}
        {#if !catalog.catalogAvailable}
          <p role="status">Model catalog unavailable.</p>
        {/if}
      {:else}
        <p role="status">Model settings unavailable.</p>
      {/if}
    </div>
  </section>

  <section aria-labelledby="quota-heading">
    <div class="settings-section-description">
      <h2 id="quota-heading" class="card-title">
        <Icon name="activity" size={20} />OpenCode quota
      </h2>
    </div>
    <div class="panel-card">
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
                · {number.format(Math.round(window.usedPercent * 10) / 10)}%
                used
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
    </div>
  </section>
</div>

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
  .effort-field {
    display: grid;
    gap: 0.5rem;
    margin-top: 1rem;
    width: min(100%, 28rem);
    min-width: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
  }
  section[aria-labelledby="usage-heading"] {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: 16px;
  }
  .history-detail {
    display: block;
    color: var(--color-muted);
    font-size: 0.75rem;
  }
  .usage-origin {
    min-width: 10rem;
  }
  .usage-model {
    min-width: 16rem;
  }
  @container (48rem <= width <= 58rem) {
    section[aria-labelledby="usage-heading"] :global(.panel-table :is(th, td)) {
      padding-inline: 8px;
    }
    .usage-origin {
      min-width: 8rem;
    }
    .usage-model {
      min-width: 12rem;
    }
  }
  .model-id {
    font-family: var(--font-mono);
    word-break: break-all;
  }
  .windows {
    margin: 0;
    padding-inline-start: 24px;
    list-style: disc;
  }
  dl {
    display: grid;
    gap: 8px;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }
  dd {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    margin: 0;
  }
</style>
