<script lang="ts">
  import ActionButton from "./components/ActionButton.svelte";
  import type { MemoryEntry } from "../../server/src/memory/host-memories.js";
  let {
    agent,
    memories,
    page,
    busy,
    remove,
    go,
    enabled,
    setEnabled,
  }: {
    enabled: boolean | undefined;
    setEnabled: (enabled: boolean) => Promise<void>;
    agent: { id: string; name: string };
    memories: { memories: MemoryEntry[]; hasMore: boolean } | undefined;
    page: number;
    busy: boolean;
    remove: (id: string) => Promise<void>;
    go: (page: number) => void;
  } = $props();
  const date = (at: number) => new Date(at).toLocaleString();
</script>

<h1 tabindex="-1">Memory of {agent.name}</h1>
<p>
  Notes this agent saved on purpose. They stay in its private volume and the
  agent reads them as untrusted context. Deleting a note removes it and its
  search entry, but earlier chat transcripts and backups may still contain
  copies.
</p>
{#if enabled !== undefined}
  <p id="memory-tools" tabindex="-1">
    Memory tools are <strong>{enabled ? "on" : "off"}</strong> for chat tasks of this
    agent. Scheduled and webhook tasks never get them.
  </p>
  <ActionButton disabled={busy} onclick={() => setEnabled(!enabled)}
    >{enabled ? "Turn memory off" : "Turn memory on"}</ActionButton
  >
{/if}
{#if !memories}
  <p role="status" data-tone="warning">
    Memory is unavailable because the Agent Host is not running.
    <a href={`/agents/${encodeURIComponent(agent.id)}/setup`}
      >Open Overview to start it</a
    >, then refresh.
  </p>
  <ActionButton onclick={() => go(page)}>Refresh memory</ActionButton>
{:else if memories.memories.length === 0}
  <p role="status">No saved notes{page > 1 ? " on this page" : ""}.</p>
{:else}
  <ul class="memory-list">
    {#each memories.memories as memory (memory.id)}
      <li>
        <h2>{memory.title}</h2>
        <p>{memory.preview}</p>
        <p>
          {#if memory.tags.length}Tags: {memory.tags.join(", ")} ·
          {/if}Updated {date(memory.updatedAt)}{#if memory.expiresAt}
            · Expires {date(memory.expiresAt)}{/if}
        </p>
        <ActionButton
          variant="danger"
          disabled={busy}
          aria-label={`Delete note ${memory.title}`}
          onclick={() => remove(memory.id)}>Delete</ActionButton
        >
      </li>
    {/each}
  </ul>
{/if}
{#if memories}<nav aria-label="Memory pages">
    <ActionButton disabled={busy || page <= 1} onclick={() => go(page - 1)}
      >Previous</ActionButton
    >
    <ActionButton
      disabled={busy || !memories?.hasMore}
      onclick={() => go(page + 1)}>Next</ActionButton
    >
  </nav>{/if}
<ActionButton href={`/agents/${encodeURIComponent(agent.id)}/setup`}
  >Back to agent</ActionButton
>
