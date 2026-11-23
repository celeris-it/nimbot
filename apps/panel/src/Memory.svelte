<script lang="ts">
  import { formattingLocale, messages } from "./i18n/language.js";
  import ActionButton from "./components/ActionButton.svelte";
  import type { MemoryEntry } from "../../server/src/memory/host-memories.js";
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
  let notesHeading: HTMLHeadingElement;
  function deleteNote(memory: MemoryEntry) {
    if (
      busy ||
      !window.confirm(
        $messages("Delete “{0}” from memory and search?", memory.title),
      )
    )
      return;
    notesHeading.focus();
    void remove(memory.id);
  }
  const date = (at: number) => new Date(at).toLocaleString($formattingLocale);
</script>

<div data-ui="page-heading" class="flex-wrap">
  <h1 tabindex="-1">{$messages("Memory of")} {agent.name}</h1>
  <ActionButton href={`/agents/${encodeURIComponent(agent.id)}/setup`}
    >{$messages("Back to agent")}</ActionButton
  >
</div>

<div class="settings-section-list">
  <section aria-labelledby="memory-notes">
    <div class="settings-section-description">
      <h2
        id="memory-notes"
        bind:this={notesHeading}
        tabindex="-1"
        class="card-title"
      >
        {$messages("Saved notes")}
      </h2>
      <p>
        {$messages(
          "Notes stay in the agent’s private volume and are read as untrusted context. Copies may remain in chat history and backups after deletion.",
        )}
      </p>
    </div>
    <div class="panel-card">
      {#if !memories}
        <p role="status" data-tone="warning">
          {$messages(
            "Memory is unavailable. Check whether the Agent Host is running, then refresh.",
          )}
        </p>
        <div class="button-row">
          <ActionButton href={`/agents/${encodeURIComponent(agent.id)}/setup`}
            >{$messages("Open Overview")}</ActionButton
          >
          <ActionButton disabled={busy} onclick={() => go(page)}
            >{$messages("Refresh memory")}</ActionButton
          >
        </div>
      {:else if memories.memories.length === 0}
        <p role="status">
          {$messages(
            page > 1 ? "No saved notes on this page" : "No saved notes",
          )}.
        </p>
      {:else}
        <ul class="memory-list">
          {#each memories.memories as memory (memory.id)}
            <li>
              <h3>{memory.title}</h3>
              <p>{memory.preview}</p>
              <p data-ui="muted">
                {#if memory.tags.length}{$messages("Tags:")}
                  {memory.tags.join(", ")} ·
                {/if}{$messages("Updated")}
                {date(memory.updatedAt)}{#if memory.expiresAt}
                  {$messages("· Expires")} {date(memory.expiresAt)}{/if}
              </p>
              <ActionButton
                variant="danger"
                disabled={busy}
                aria-label={$messages("Delete note {0}", memory.title)}
                onclick={() => deleteNote(memory)}
                >{$messages("Delete")}</ActionButton
              >
            </li>
          {/each}
        </ul>
      {/if}
      {#if memories && (page > 1 || memories.hasMore)}
        <nav
          class="button-row items-center"
          aria-label={$messages("Memory pages")}
        >
          <ActionButton
            disabled={busy || page <= 1}
            onclick={() => go(page - 1)}>{$messages("Previous")}</ActionButton
          >
          <span data-ui="muted">{$messages("Page")} {page}</span>
          <ActionButton
            disabled={busy || !memories.hasMore}
            onclick={() => go(page + 1)}>{$messages("Next")}</ActionButton
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
