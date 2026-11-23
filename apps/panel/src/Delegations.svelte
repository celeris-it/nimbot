<script lang="ts">
  import { formattingLocale, messages } from "./i18n/language.js";
  import ActionButton from "./components/ActionButton.svelte";
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
  const statuses: Record<DelegationHistoryEntry["status"], string> = $derived({
    pending: $messages("Pending handoff"),
    discarded: $messages("Discarded"),
    queued: $messages("Queued"),
    running: $messages("Running"),
    completed: $messages("Completed"),
    failed: $messages("Failed"),
    cancelled: $messages("Cancelled"),
    interrupted: $messages("Interrupted"),
    unavailable: $messages("Child unavailable"),
  });
  const reasons = new Map([
    ["parent_failed", $messages("Parent task failed.")],
    ["parent_cancelled", $messages("Parent task was cancelled.")],
    ["parent_interrupted", $messages("Parent task was interrupted.")],
    ["access_revoked", $messages("Delegation access was revoked.")],
  ]);
</script>

<h1 tabindex="-1">{$messages("Delegations from")} {agent.name}</h1>
<ActionButton disabled={busy} onclick={refresh}
  >{$messages("Refresh delegations")}</ActionButton
>
<ActionButton href={`${base}/setup`}>{$messages("Back to agent")}</ActionButton>
{#if !data}
  <p role="status">
    {$messages("Delegation history is unavailable. Refresh to try again.")}
  </p>
{:else if data.delegations.length === 0}
  <p role="status">
    {$messages(page > 1 ? "No delegations on this page" : "No delegations")}.
  </p>
{:else}
  <ul
    class="history"
    aria-label={$messages("Delegation history")}
    aria-busy={busy}
  >
    {#each data.delegations as entry (entry.id)}
      {@const reason = entry.reason ? reasons.get(entry.reason) : undefined}
      <li class="panel-card">
        <h2>{$messages("To")} {entry.targetAgentId}</h2>
        <p>
          <strong>{statuses[entry.status]}</strong>
          {#if entry.status === "running" && entry.cancellationRequested}
            {$messages("· Cancellation requested")}
          {/if}
          · {new Date(entry.createdAt).toLocaleString($formattingLocale)}
        </p>
        <p class="brief">{entry.briefPreview}</p>
        {#if reason}<p>{reason}</p>{/if}
        {#if entry.canCancel}
          <ActionButton disabled={busy} onclick={() => cancel(entry.id)}
            >{$messages("Cancel child")}</ActionButton
          >
        {/if}
      </li>
    {/each}
  </ul>
{/if}
{#if page > 1 || data?.hasMore}
  <nav aria-label={$messages("Delegation pages")}>
    {#if page > 1}
      <ActionButton href={`${base}/delegations?page=${page - 1}`}
        >{$messages("Previous")}</ActionButton
      >
    {/if}
    <span>{$messages("Page")} {page}</span>
    {#if data?.hasMore && page < 1000}
      <ActionButton href={`${base}/delegations?page=${page + 1}`}
        >{$messages("Next")}</ActionButton
      >
    {/if}
  </nav>
{/if}

<style>
  .history {
    display: grid;
    gap: 16px;
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
    gap: 16px;
  }
</style>
