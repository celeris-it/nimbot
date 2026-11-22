<script lang="ts">
  import type { AgentSummary } from "../../server/src/panel/panel-contracts.js";
  import { Icon, SearchField } from "./components/index.js";

  let {
    agents,
    matches,
    current,
    section,
    loading,
    unavailable,
    refresh,
    query = $bindable(""),
  }: {
    agents: AgentSummary[];
    matches: AgentSummary[];
    current: AgentSummary | undefined;
    section: string;
    loading: boolean;
    unavailable: boolean;
    refresh: () => void;
    query?: string;
  } = $props();

  let switcher: HTMLDetailsElement;
  let summary: HTMLElement;
  let search: HTMLFormElement;
  let searching = $state(false);
  let showResults = $derived(searching && query.trim().length > 0);
  const href = (id: string, view: string) =>
    `/agents/${encodeURIComponent(id)}/${view}`;

  function dismissOutside(event: Event) {
    if (!(event.target instanceof Node)) return;
    if (!switcher.contains(event.target)) switcher.open = false;
    if (!search.contains(event.target)) searching = false;
  }

  function handleKeys(event: KeyboardEvent) {
    if (!(event.target instanceof Node)) return;
    if (
      switcher.open &&
      switcher.contains(event.target) &&
      event.key === "Escape"
    ) {
      event.preventDefault();
      switcher.open = false;
      summary.focus();
    }
    if (!showResults || !search.contains(event.target)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      search.querySelector("input")?.focus();
      searching = false;
    }
    if (event.key === "ArrowDown" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      search.querySelector("a")?.focus();
    }
  }
</script>

<svelte:window
  onclick={dismissOutside}
  onfocusin={dismissOutside}
  onkeydown={handleKeys}
/>

{#snippet agentLinks(items: AgentSummary[], view: string)}
  <ul class="panel-menu">
    {#each items as item (item.id)}
      <li>
        <a
          href={href(item.id, view)}
          aria-current={current?.id === item.id ? "true" : undefined}
        >
          <span>{item.name}</span>
          <small>{item.botUsername ? `@${item.botUsername}` : item.id}</small>
        </a>
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet directoryStatus(empty: string)}
  {#if loading}
    <p role="status">Loading agents…</p>
  {:else if unavailable}
    <p role="status">Agent list unavailable.</p>
    <button class="panel-button" type="button" onclick={refresh}
      >Retry loading agents</button
    >
  {:else}
    <p role="status">{empty}</p>
  {/if}
{/snippet}

<div data-ui="agent-header">
  <details
    data-ui="agent-switcher"
    bind:this={switcher}
    ontoggle={() => {
      if (switcher.open) refresh();
    }}
  >
    <summary
      bind:this={summary}
      aria-label={current ? `Switch agent, ${current.name}` : "Switch agent"}
    >
      <span>{current?.name ?? "Switch agent"}</span>
      <Icon name="chevron" size={16} />
    </summary>
    <div data-ui="agent-header-popover">
      {#if agents.length}
        {@render agentLinks(agents, section)}
      {:else}
        {@render directoryStatus("No agents yet.")}
      {/if}
    </div>
  </details>

  <form
    data-ui="agent-header-search"
    bind:this={search}
    role="search"
    aria-label="Agents"
    onsubmit={(event) => {
      event.preventDefault();
      if (showResults) search.querySelector("a")?.click();
    }}
  >
    <SearchField
      label="Search agents"
      placeholder="Search agents"
      bind:value={query}
      onfocus={() => {
        searching = true;
        refresh();
      }}
      oninput={() => (searching = true)}
    />
    {#if showResults}
      <div
        data-ui="agent-header-popover"
        role="region"
        aria-label="Matching agents"
      >
        {#if matches.length}
          {@render agentLinks(matches, "setup")}
        {:else}
          {@render directoryStatus("No matching agents.")}
        {/if}
      </div>
    {/if}
  </form>
</div>
