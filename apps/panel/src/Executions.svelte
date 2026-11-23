<script lang="ts">
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

  const origins = {
    telegram: "Telegram",
    discord: "Discord",
    schedule: "Schedule",
    webhook: "Webhook",
    delegated: "Delegation",
  };
  const statuses = {
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  };
  const deliveries = {
    pending: "Pending",
    delivered: "Delivered",
    not_sent: "Not sent",
    unconfirmed: "Unconfirmed",
    unknown: "Unknown",
    not_applicable: "Not applicable",
  };
  const failureReasons = new Map([
    ["attachment_unavailable", "The attachment could not be opened."],
    ["busy", "The Agent Host was busy."],
    ["failed", "The Agent Host reported a failure."],
    ["interrupted", "The execution was interrupted."],
    ["timeout", "The Server timed out waiting for the Agent Host."],
    ["unavailable", "The Server could not confirm the Agent Host status."],
    ["cancelled", "The execution was cancelled."],
    ["not_ready", "The agent was no longer ready to run the task."],
  ]);
  const columns = [
    { label: "Source" },
    { label: "Execution" },
    { label: "Created" },
    { label: "Duration" },
    { label: "Chat delivery" },
    { label: "Details" },
  ];
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
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
    return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
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
      <span class="block">To {origins[entry.channel]}</span>
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
      aria-label={`View execution ${entry.id}`}>View</ActionButton
    >
  </td>
{/snippet}

{#if selected}
  <h1 tabindex="-1">Execution details</h1>
  <ActionButton href={href(before)}>Back to executions</ActionButton>
  {#if detail}
    <dl class="panel-card grid grid-cols-2 gap-3 sm:grid-cols-3">
      <div>
        <dt>Source</dt>
        <dd>
          {origins[detail.origin]}{detail.scheduleName
            ? ` · ${detail.scheduleName}`
            : ""}
        </dd>
      </div>
      <div>
        <dt>Execution</dt>
        <dd>{statuses[detail.status]}</dd>
      </div>
      <div>
        <dt>Chat delivery</dt>
        <dd>
          {detail.channel
            ? `${origins[detail.channel]} · `
            : ""}{detail.finishedAt === null
            ? "Awaiting execution"
            : deliveries[detail.delivery]}
        </dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd>{@render timestamp(detail.createdAt)}</dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>{@render timestamp(detail.startedAt)}</dd>
      </div>
      <div>
        <dt>Finished</dt>
        <dd>{@render timestamp(detail.finishedAt)}</dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{duration(detail)}</dd>
      </div>
      {#if detail.failureReason}
        <div class="col-span-full">
          <dt>Reason</dt>
          <dd>
            {failureReasons.get(detail.failureReason) ?? detail.failureReason}
          </dd>
        </div>
      {/if}
    </dl>
    <section class="panel-card">
      <h2>Request</h2>
      {#if detail.prompt}
        <pre>{detail.prompt}</pre>
      {:else}
        <p>This execution has no request text.</p>
      {/if}
    </section>
    <section class="panel-card">
      <h2>{detail.response?.partial ? "Partial response" : "Response"}</h2>
      {#if detail.response?.text}
        <pre>{detail.response.text}</pre>
      {:else if detail.response}
        <p>The execution finished with an empty response.</p>
      {:else}
        <p>
          {detail.finishedAt === null
            ? "A response is not available yet."
            : "No saved response is available."}
        </p>
      {/if}
    </section>
  {:else if detail === null}
    <p role="status">Execution not found.</p>
  {/if}
{:else}
  <h1 tabindex="-1">Executions</h1>
  {#if data}
    <DataTable
      caption="Running and queued"
      {columns}
      rows={data.active}
      {row}
      rowKey={(entry) => entry.id}
      empty="No running or queued executions."
    />
    <DataTable
      caption="Execution history"
      {columns}
      rows={data.history}
      {row}
      rowKey={(entry) => entry.id}
      empty="No finished executions on this page."
    >
      {#snippet footer()}
        {#if before || data?.nextCursor}
          <nav
            aria-label="Execution history pages"
            class="flex flex-wrap gap-2"
          >
            {#if before}<ActionButton href={base}
                >Latest executions</ActionButton
              >{/if}
            {#if data?.nextCursor}
              <ActionButton href={href(data.nextCursor)}
                >Older executions</ActionButton
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
