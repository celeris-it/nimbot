<script lang="ts">
  import { formattingLocale, messages } from "./i18n/language.js";
  import {
    ActionButton,
    Icon,
    DataTable,
    StatusBadge,
  } from "./components/index.js";
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
  const number = $derived(new Intl.NumberFormat($formattingLocale));
  const usd = $derived(
    new Intl.NumberFormat($formattingLocale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }),
  );
  const money = (value: number | null) =>
    value === null
      ? $messages("Unavailable")
      : value > 0 && value < 0.000001
        ? `< ${usd.format(0.000001)}`
        : usd.format(value);
  const time = (timestamp: number) =>
    new Date(timestamp).toLocaleString($formattingLocale);
  const quotaText = $derived({
    available: $messages("Quota available"),
    unavailable: $messages("Quota unavailable"),
    exhausted: $messages("Queue paused for quota"),
    checking: $messages("Waiting for a quota check"),
    model_unavailable: $messages(
      "Queue paused because the model is unavailable",
    ),
    effort_unavailable: $messages(
      "Queue paused because the reasoning effort is unavailable",
    ),
  });
  const failureText: Record<
    NonNullable<QuotaStatus["failure"]>,
    string
  > = $derived({
    host_unavailable: $messages(
      "The Agent Host could not return its model status. Check the Host on the agent setup page.",
    ),
    opencode_missing: $messages(
      "OpenCode was not found on the Agent Host’s PATH. Install the version required by Nimbot and restart Nimbot.",
    ),
    opencode_start_failed: $messages(
      "OpenCode exited before it could serve models. Check that Nimbot is using OpenCode 2.2.7, then restart Nimbot.",
    ),
    opencode_start_timeout: $messages(
      "OpenCode did not become ready in time. Check the OpenCode installation and restart the agent.",
    ),
    opencode_check_failed: $messages(
      "OpenCode could not check the model or quota. Check the AI provider connection and model settings.",
    ),
    quota_check_failed: $messages(
      "OpenCode did not return quota data for the connected account. Check the OpenCode Console connection.",
    ),
  });
  const origins: Record<string, string> = $derived({
    telegram: "Telegram",
    discord: "Discord",
    delegated: $messages("Delegation"),
    schedule: $messages("Schedule"),
    webhook: $messages("Webhook"),
  });

  const historyColumns = $derived([
    { label: $messages("Started") },
    { label: $messages("Status") },
    { label: $messages("Origin") },
    { label: $messages("Model") },
    { label: $messages("Tokens"), numeric: true },
    { label: $messages("Reported cost (USD)"), numeric: true },
  ]);
  const historyDate = $derived(
    new Intl.DateTimeFormat($formattingLocale, {
      dateStyle: "medium",
    }),
  );
  const historyTime = $derived(
    new Intl.DateTimeFormat($formattingLocale, {
      timeStyle: "medium",
    }),
  );
  const historyStatus: Record<
    string,
    { label: string; tone: "neutral" | "good" | "warning" | "danger" }
  > = $derived({
    completed: { label: $messages("Completed"), tone: "good" },
    failed: { label: $messages("Failed"), tone: "danger" },
    interrupted: { label: $messages("Interrupted"), tone: "warning" },
    cancelled: { label: $messages("Cancelled"), tone: "neutral" },
    running: { label: $messages("Running"), tone: "neutral" },
    queued: { label: $messages("Queued"), tone: "neutral" },
  });
</script>

<h1 tabindex="-1">{$messages("Model and usage for")} {agent.name}</h1>
<nav class="actions" aria-label={$messages("Agent actions")}>
  <ActionButton href={`${base}/setup`}
    >{$messages("Back to agent")}</ActionButton
  >
  <ActionButton href="/providers">{$messages("AI providers")}</ActionButton>
  <ActionButton onclick={refresh} disabled={busy}
    >{$messages("Refresh")}</ActionButton
  >
</nav>

<div class="settings-section-list">
  <section aria-labelledby="model-heading">
    <div class="settings-section-description">
      <h2 id="model-heading" tabindex="-1" class="card-title">
        <Icon name="cpu" size={20} />{$messages("Model")}
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
            <label for="model-effort">{$messages("Reasoning effort")}</label>
            <Select
              id="model-effort"
              bind:value={effortValue}
              disabled={busy || !selectedModel || !catalog.catalogAvailable}
              aria-describedby={missingEffort
                ? "model-effort-status"
                : undefined}
              onchange={changeEffort}
            >
              <option value="">{$messages("Default")}</option>
              {#if selectedEffort && !efforts.includes(selectedEffort)}
                <option value={selectedEffort} disabled>
                  {effortLabel(selectedEffort)}{missingEffort
                    ? $messages(" (Unavailable)")
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
                  ? $messages(
                      "Choose another reasoning effort or Default to resume the queue.",
                    )
                  : $messages(
                      "Choose an available model or Automatic to resume the queue.",
                    )}
              </p>
            {/if}
          </div>
        {/if}
        {#if busy}<p role="status">
            {$messages("Saving model settings…")}
          </p>{/if}
        {#if !catalog.catalogAvailable}
          <p role="status">{$messages("Model catalog unavailable.")}</p>
        {/if}
      {:else}
        <p role="status">{$messages("Model settings unavailable.")}</p>
      {/if}
    </div>
  </section>

  <section aria-labelledby="quota-heading">
    <div class="settings-section-description">
      <h2 id="quota-heading" class="card-title">
        <Icon name="activity" size={20} />{$messages("Provider quota")}
      </h2>
    </div>
    <div class="panel-card">
      {#if data?.quota}
        {@const quota = data.quota}
        <p>
          <strong
            >{quota.failure
              ? $messages("Model or quota check failed")
              : quotaText[quota.state]}</strong
          >
          {#if quota.model}
            · {quota.model.providerId}/{quota.model.modelId}{/if}
        </p>
        {#if quota.failure}
          <p role="status">{failureText[quota.failure]}</p>
        {/if}
        {#if data.queued}<p>
            {number.format(data.queued)}
            {$messages("queued")}
          </p>{/if}
        <p>{$messages("Last checked")} {time(quota.checkedAt)}</p>
        {#if quota.windows.length}
          <ul class="windows">
            {#each quota.windows as window (window)}
              <li>
                <strong>{window.name}</strong>
                · {number.format(
                  Math.round(window.usedPercent * 10) / 10,
                )}{$messages("% used")}
                {#if window.name.startsWith($messages("ChatGPT "))}
                  · {number.format(
                    Math.round((100 - window.usedPercent) * 10) / 10,
                  )}{$messages("% left")}
                {/if}
                {#if window.spentUsd !== undefined && window.limitUsd !== undefined}
                  · {money(window.spentUsd)}
                  {$messages("of")}
                  {money(window.limitUsd)}
                {/if}
                {#if window.exhausted}
                  {$messages("· Limit reached")}{/if}
                {$messages("· Resets")}
                {time(window.resetsAt)}
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p role="status">{$messages("Waiting for the first quota check.")}</p>
      {/if}
    </div>
  </section>
</div>

<section aria-labelledby="usage-heading">
  <h2 id="usage-heading">{$messages("Usage")}</h2>
  {#if data}
    <div class="totals">
      {#each [{ name: $messages("Today (UTC)"), value: data.today }, { name: $messages("This month (UTC)"), value: data.month }] as total (total.name)}
        <div class="panel-card">
          <h3>{total.name}</h3>
          <dl>
            <div>
              <dt>{$messages("Tokens")}</dt>
              <dd>{number.format(total.value.tokens)}</dd>
            </div>
            <div>
              <dt>{$messages("Reported cost (USD)")}</dt>
              <dd>{total.value.tasks ? money(total.value.costUsd) : "—"}</dd>
            </div>
            <div>
              <dt>{$messages("Tasks")}</dt>
              <dd>{number.format(total.value.tasks)}</dd>
            </div>
          </dl>
          {#if total.value.incomplete || total.value.missingCost}
            <p>
              {number.format(total.value.incomplete)}
              {$messages("with incomplete usage ·")}
              {number.format(total.value.missingCost)}
              {$messages("without cost")}
            </p>
          {/if}
        </div>
      {/each}
    </div>
    {#snippet historyPages()}
      <nav class="actions" aria-label={$messages("Usage history pages")}>
        {#if before}<ActionButton href={`${base}/usage`}
            >{$messages("Newest tasks")}</ActionButton
          >{/if}
        {#if data?.next}<ActionButton href={`${base}/usage?before=${data.next}`}
            >{$messages("Older tasks")}</ActionButton
          >{/if}
      </nav>
    {/snippet}
    <DataTable
      caption="Task usage history"
      columns={historyColumns}
      rows={data.tasks}
      rowKey={(task) => task.id}
      empty={$messages("No model tasks on this page.")}
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
              >{$messages("Partial usage")}</small
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
            <span class="text-muted">{$messages("Unavailable")}</span>
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
              {$messages("In")}
              {number.format(usage.tokens.input)}
              {$messages("· Out")}
              {number.format(usage.tokens.output)}
            </small>
          {:else}
            <span class="text-muted">{$messages("Unavailable")}</span>
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
    <p role="status">
      {$messages("Usage history unavailable. Refresh to try again.")}
    </p>
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
