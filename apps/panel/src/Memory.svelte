<script lang="ts">
  import type { MemoryEntry } from "../../server/src/host-memories.js";
  let {
    agent,
    memories,
    page,
    busy,
    remove,
    go,
  }: {
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
{#if !memories}
  <p role="status">
    Memory unavailable. Start the agent and refresh to try again.
  </p>
  <button class="btn" onclick={() => go(page)}>Refresh memory</button>
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
        <button
          class="btn"
          disabled={busy}
          aria-label={`Delete note ${memory.title}`}
          onclick={() => remove(memory.id)}>Delete</button
        >
      </li>
    {/each}
  </ul>
{/if}
<nav aria-label="Memory pages">
  <button class="btn" disabled={busy || page <= 1} onclick={() => go(page - 1)}
    >Previous</button
  >
  <button
    class="btn"
    disabled={busy || !memories?.hasMore}
    onclick={() => go(page + 1)}>Next</button
  >
</nav>
<a class="btn" href={`/agents/${encodeURIComponent(agent.id)}/setup`}
  >Back to agent</a
>
