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
  let notesHeading: HTMLHeadingElement;
  function deleteNote(memory: MemoryEntry) {
    if (
      busy ||
      !window.confirm(`Delete “${memory.title}” from memory and search?`)
    )
      return;
    notesHeading.focus();
    void remove(memory.id);
  }
  const date = (at: number) => new Date(at).toLocaleString();
</script>

<div data-ui="page-heading" class="flex-wrap">
  <h1 tabindex="-1">Memory of {agent.name}</h1>
  <ActionButton href={`/agents/${encodeURIComponent(agent.id)}/setup`}
    >Back to agent</ActionButton
  >
</div>

<div class="settings-section-list">
  {#if enabled !== undefined}
    <section aria-labelledby="memory-tools">
      <div class="settings-section-description">
        <h2 id="memory-tools" tabindex="-1" class="card-title">Memory tools</h2>
        <p>
          Available for chat tasks. Scheduled and webhook tasks have no memory
          tools.
        </p>
      </div>
      <div class="panel-card">
        <p>Memory tools are <strong>{enabled ? "on" : "off"}</strong>.</p>
        <ActionButton
          variant={enabled ? "default" : "primary"}
          disabled={busy}
          onclick={() => setEnabled(!enabled)}
          >{enabled ? "Turn memory off" : "Turn memory on"}</ActionButton
        >
      </div>
    </section>
  {/if}
  <section aria-labelledby="memory-notes">
    <div class="settings-section-description">
      <h2
        id="memory-notes"
        bind:this={notesHeading}
        tabindex="-1"
        class="card-title"
      >
        Saved notes
      </h2>
      <p>
        Notes stay in the agent’s private volume and are read as untrusted
        context. Copies may remain in chat history and backups after deletion.
      </p>
    </div>
    <div class="panel-card">
      {#if !memories}
        <p role="status" data-tone="warning">
          Memory is unavailable. Check whether the Agent Host is running, then
          refresh.
        </p>
        <div class="button-row">
          <ActionButton href={`/agents/${encodeURIComponent(agent.id)}/setup`}
            >Open Overview</ActionButton
          >
          <ActionButton disabled={busy} onclick={() => go(page)}
            >Refresh memory</ActionButton
          >
        </div>
      {:else if memories.memories.length === 0}
        <p role="status">No saved notes{page > 1 ? " on this page" : ""}.</p>
      {:else}
        <ul class="memory-list">
          {#each memories.memories as memory (memory.id)}
            <li>
              <h3>{memory.title}</h3>
              <p>{memory.preview}</p>
              <p data-ui="muted">
                {#if memory.tags.length}Tags: {memory.tags.join(", ")} ·
                {/if}Updated {date(memory.updatedAt)}{#if memory.expiresAt}
                  · Expires {date(memory.expiresAt)}{/if}
              </p>
              <ActionButton
                variant="danger"
                disabled={busy}
                aria-label={`Delete note ${memory.title}`}
                onclick={() => deleteNote(memory)}>Delete</ActionButton
              >
            </li>
          {/each}
        </ul>
      {/if}
      {#if memories && (page > 1 || memories.hasMore)}
        <nav class="button-row items-center" aria-label="Memory pages">
          <ActionButton
            disabled={busy || page <= 1}
            onclick={() => go(page - 1)}>Previous</ActionButton
          >
          <span data-ui="muted">Page {page}</span>
          <ActionButton
            disabled={busy || !memories.hasMore}
            onclick={() => go(page + 1)}>Next</ActionButton
          >
        </nav>
      {/if}
    </div>
  </section>
</div>

<style>
  .memory-list {
    display: grid;
    gap: 16px;
    overflow-wrap: anywhere;
  }
  .memory-list li {
    display: grid;
    gap: 8px;
    justify-items: start;
  }
  .memory-list li + li {
    padding-block-start: 16px;
    border-block-start: 1px solid var(--color-base-300);
  }
</style>
