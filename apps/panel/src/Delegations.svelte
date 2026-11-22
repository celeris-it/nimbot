<script lang="ts">
  import type {
    DelegationHistory,
    DelegationHistoryEntry,
  } from "../../server/src/panel/panel-contracts.js";

  let {
    agent,
    data,
    page,
    busy,
    cancel,
    refresh,
  }: {
    agent: { id: string; name: string };
    data: DelegationHistory | undefined;
    page: number;
    busy: boolean;
    cancel: (id: string) => Promise<void>;
    refresh: () => void;
  } = $props();

  let base = $derived(`/agents/${encodeURIComponent(agent.id)}`);
  const statuses: Record<DelegationHistoryEntry["status"], string> = {
    pending: "Pending handoff",
    discarded: "Discarded",
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    unavailable: "Child unavailable",
  };
  const reasons = new Map([
    ["parent_failed", "Parent task failed."],
    ["parent_cancelled", "Parent task was cancelled."],
    ["parent_interrupted", "Parent task was interrupted."],
    ["access_revoked", "Delegation access was revoked."],
  ]);
</script>

<h1 tabindex="-1">Delegations from {agent.name}</h1>
<button class="panel-button" disabled={busy} onclick={refresh}
  >Refresh delegations</button
>
<a class="panel-button" href={`${base}/setup`}>Back to agent</a>
{#if !data}
  <p role="status">Delegation history is unavailable. Refresh to try again.</p>
{:else if data.delegations.length === 0}
  <p role="status">No delegations{page > 1 ? " on this page" : ""}.</p>
{:else}
  <ul class="history" aria-label="Delegation history" aria-busy={busy}>
    {#each data.delegations as entry (entry.id)}
      {@const reason = entry.reason ? reasons.get(entry.reason) : undefined}
      <li class="panel-card">
        <h2>To {entry.targetAgentId}</h2>
        <p>
          <strong>{statuses[entry.status]}</strong>
          {#if entry.status === "running" && entry.cancellationRequested}
            · Cancellation requested
          {/if}
          · {new Date(entry.createdAt).toLocaleString()}
        </p>
        <p class="brief">{entry.briefPreview}</p>
        {#if reason}<p>{reason}</p>{/if}
        {#if entry.canCancel}
          <button
            class="panel-button"
            disabled={busy}
            onclick={() => cancel(entry.id)}>Cancel child</button
          >
        {/if}
      </li>
    {/each}
  </ul>
{/if}
{#if page > 1 || data?.hasMore}
  <nav aria-label="Delegation pages">
    {#if page > 1}
      <a class="panel-button" href={`${base}/delegations?page=${page - 1}`}
        >Previous</a
      >
    {/if}
    <span>Page {page}</span>
    {#if data?.hasMore && page < 1000}
      <a class="panel-button" href={`${base}/delegations?page=${page + 1}`}
        >Next</a
      >
    {/if}
  </nav>
{/if}

<style>
  .history {
    display: grid;
    gap: 0.75rem;
    padding: 0;
    list-style: none;
    overflow-wrap: anywhere;
  }
  .brief {
    white-space: pre-wrap;
  }
  nav {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }
</style>
