<script lang="ts">
  import { formattingLocale, messages } from "./i18n/language.js";
  import type {
    ExecutionDetail,
    ExecutionEntry,
    ExecutionPage,
  } from "../../server/src/panel/panel-contracts.js";
  import { ActionButton, DataTable, StatusBadge } from "./components/index.js";

  let {
    agentId,
    data,
    detail,
    before,
    selected,
  }: {
    agentId: string;
    data: ExecutionPage | undefined;
    detail: ExecutionDetail | null | undefined;
    before: string | null;
    selected: string | null;
  } = $props();

  const origins = $derived({
    telegram: "Telegram",
    discord: "Discord",
    schedule: $messages("Schedule"),
    webhook: $messages("Webhook"),
    delegated: $messages("Delegation"),
  });
  const statuses = $derived({
    queued: $messages("Queued"),
    running: $messages("Running"),
    completed: $messages("Completed"),
    failed: $messages("Failed"),
    cancelled: $messages("Cancelled"),
    interrupted: $messages("Interrupted"),
  });
  const deliveries = $derived({
    pending: $messages("Pending"),
    delivered: $messages("Delivered"),
    not_sent: $messages("Not sent"),
    unconfirmed: $messages("Unconfirmed"),
    unknown: $messages("Unknown"),
    not_applicable: $messages("Not applicable"),
  });
  const failureReasons = $derived(
    new Map([
      [
        "attachment_unavailable",
        $messages("The attachment could not be opened."),
      ],
      ["busy", $messages("The Agent Host was busy.")],
      ["failed", $messages("The Agent Host reported a failure.")],
      ["interrupted", $messages("The execution was interrupted.")],
      [
        "timeout",
        $messages("The Server timed out waiting for the Agent Host."),
      ],
      [
        "unavailable",
        $messages("The Server could not confirm the Agent Host status."),
      ],
      ["cancelled", $messages("The execution was cancelled.")],
      [
        "not_ready",
        $messages("The agent was no longer ready to run the task."),
      ],
    ]),
  );
  const columns = $derived([
    { label: $messages("Source") },
    { label: $messages("Execution") },
    { label: $messages("Created") },
    { label: $messages("Duration") },
    { label: $messages("Chat delivery") },
    { label: $messages("Details") },
  ]);
  const dateFormat = $derived(
    new Intl.DateTimeFormat($formattingLocale, {
      dateStyle: "medium",
      timeStyle: "medium",
    }),
  );
  let base = $derived(`/agents/${encodeURIComponent(agentId)}/executions`);

  function href(cursor: string | null, task: string | null = null) {
    const query = new URLSearchParams();
    if (cursor) query.set("before", cursor);
    if (task) query.set("task", task);
    return query.size ? `${base}?${query}` : base;
  }

  function duration(entry: ExecutionEntry) {
    if (entry.startedAt === null || entry.finishedAt === null) return "—";
    const seconds = Math.max(
      0,
      Math.floor((entry.finishedAt - entry.startedAt) / 1000),
    );
    const minutes = Math.floor(seconds / 60);
    return minutes
      ? $messages("{0}m {1}s", minutes, seconds % 60)
      : `${seconds}s`;
  }
</script>

{#snippet timestamp(value: number | null)}
  {#if value === null}
    —
  {:else}
    <time datetime={new Date(value).toISOString()}
      >{dateFormat.format(value)}</time
    >
  {/if}
{/snippet}

{#snippet row(entry: ExecutionEntry)}
  <td>
    <strong>{origins[entry.origin]}</strong>
    {#if entry.scheduleName}<span class="block wrap-anywhere"
        >{entry.scheduleName}</span
      >{/if}
    {#if entry.channel && entry.channel !== entry.origin}
      <span class="block">{$messages("To")} {origins[entry.channel]}</span>
    {/if}
  </td>
  <td>
    <StatusBadge
      label={statuses[entry.status]}
      tone={entry.status === "completed"
        ? "good"
        : entry.status === "failed"
          ? "danger"
          : entry.status === "interrupted" || entry.status === "running"
            ? "warning"
            : "neutral"}
    />
  </td>
  <td>{@render timestamp(entry.createdAt)}</td>
  <td>{duration(entry)}</td>
  <td>{entry.finishedAt === null ? "—" : deliveries[entry.delivery]}</td>
  <td>
    <ActionButton
      href={href(before, entry.id)}
      aria-label={$messages("View execution {0}", entry.id)}
      >{$messages("View")}</ActionButton
    >
  </td>
{/snippet}

{#if selected}
  <h1 tabindex="-1">{$messages("Execution details")}</h1>
  <ActionButton href={href(before)}
    >{$messages("Back to executions")}</ActionButton
  >
  {#if detail}
    <dl class="panel-card grid grid-cols-2 gap-3 sm:grid-cols-3">
      <div>
        <dt>{$messages("Source")}</dt>
        <dd>
          {origins[detail.origin]}{detail.scheduleName
            ? ` · ${detail.scheduleName}`
            : ""}
        </dd>
      </div>
      <div>
        <dt>{$messages("Execution")}</dt>
        <dd>{statuses[detail.status]}</dd>
      </div>
      <div>
        <dt>{$messages("Chat delivery")}</dt>
        <dd>
          {detail.channel
            ? `${origins[detail.channel]} · `
            : ""}{detail.finishedAt === null
            ? $messages("Awaiting execution")
            : deliveries[detail.delivery]}
        </dd>
      </div>
      <div>
        <dt>{$messages("Created")}</dt>
        <dd>{@render timestamp(detail.createdAt)}</dd>
      </div>
      <div>
        <dt>{$messages("Started")}</dt>
        <dd>{@render timestamp(detail.startedAt)}</dd>
      </div>
      <div>
        <dt>{$messages("Finished")}</dt>
        <dd>{@render timestamp(detail.finishedAt)}</dd>
      </div>
      <div>
        <dt>{$messages("Duration")}</dt>
        <dd>{duration(detail)}</dd>
      </div>
      {#if detail.failureReason}
        <div class="col-span-full">
          <dt>{$messages("Reason")}</dt>
          <dd>
            {failureReasons.get(detail.failureReason) ?? detail.failureReason}
          </dd>
        </div>
      {/if}
    </dl>
    <section class="panel-card">
      <h2>{$messages("Request")}</h2>
      {#if detail.prompt}
        <pre>{detail.prompt}</pre>
      {:else}
        <p>{$messages("This execution has no request text.")}</p>
      {/if}
    </section>
    <section class="panel-card">
      <h2>
        {detail.response?.partial
          ? $messages("Partial response")
          : $messages("Response")}
      </h2>
      {#if detail.response?.text}
        <pre>{detail.response.text}</pre>
      {:else if detail.response}
        <p>{$messages("The execution finished with an empty response.")}</p>
      {:else}
        <p>
          {detail.finishedAt === null
            ? $messages("A response is not available yet.")
            : $messages("No saved response is available.")}
        </p>
      {/if}
    </section>
  {:else if detail === null}
    <p role="status">{$messages("Execution not found.")}</p>
  {/if}
{:else}
  <h1 tabindex="-1">{$messages("Executions")}</h1>
  {#if data}
    <DataTable
      caption="Running and queued"
      {columns}
      rows={data.active}
      {row}
      rowKey={(entry) => entry.id}
      empty={$messages("No running or queued executions.")}
    />
    <DataTable
      caption="Execution history"
      {columns}
      rows={data.history}
      {row}
      rowKey={(entry) => entry.id}
      empty={$messages("No finished executions on this page.")}
    >
      {#snippet footer()}
        {#if before || data?.nextCursor}
          <nav
            aria-label={$messages("Execution history pages")}
            class="flex flex-wrap gap-2"
          >
            {#if before}<ActionButton href={base}
                >{$messages("Latest executions")}</ActionButton
              >{/if}
            {#if data?.nextCursor}
              <ActionButton href={href(data.nextCursor)}
                >{$messages("Older executions")}</ActionButton
              >
            {/if}
          </nav>
        {/if}
      {/snippet}
    </DataTable>
  {/if}
{/if}

<style>
  dt {
    font-weight: 600;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
