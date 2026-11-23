<script lang="ts">
  import type { AgentSummary } from "../../server/src/panel/panel-contracts.js";
  import { matchingOptions, type ConfigurationGroup } from "./option-search.js";
  import {
    ActionButton,
    AgentAvatar,
    Icon,
    SearchField,
  } from "./components/index.js";

  let {
    agents,
    options,
    current,
    section,
    loading,
    unavailable,
    refresh,
    query = $bindable(""),
  }: {
    agents: AgentSummary[];
    options: ConfigurationGroup[];
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
  let switcherOpened = $state(false);
  let searching = $state(false);
  let showResults = $derived(searching && query.trim().length > 0);
  let matches = $derived(matchingOptions(options, query));
  const href = (id: string, view: string) =>
    `/agents/${encodeURIComponent(id)}/${view}`;

  function dismissOutside(event: Event) {
    const path = event.composedPath();
    if (!path.includes(switcher)) switcher.open = false;
    if (!path.includes(search)) searching = false;
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
      {@const identifier = item.botUsername ? `@${item.botUsername}` : item.id}
      <li>
        <a
          href={href(item.id, view)}
          aria-current={current?.id === item.id ? "true" : undefined}
        >
          <AgentAvatar agentId={item.id} name={item.name} small />
          <span>
            <span class="block truncate" title={item.name}>{item.name}</span>
            <small class="truncate" title={identifier}>{identifier}</small>
          </span>
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
    <ActionButton type="button" onclick={refresh}
      >Retry loading agents</ActionButton
    >
  {:else}
    <p role="status">{empty}</p>
  {/if}
{/snippet}

<div data-ui="agent-header">
  <form
    data-ui="agent-header-search"
    bind:this={search}
    role="search"
    aria-label="Configuration options"
    onsubmit={(event) => {
      event.preventDefault();
      if (showResults) search.querySelector("a")?.click();
    }}
  >
    <SearchField
      label="Search options"
      placeholder="Search options"
      bind:value={query}
      onfocus={() => {
        if (!searching && !unavailable) refresh();
        searching = true;
      }}
      oninput={() => (searching = true)}
    />
    {#if showResults}
      <div
        data-ui="agent-header-popover"
        role="region"
        aria-label="Matching options"
      >
        {#each matches as group (group.key)}
          <div
            data-ui="option-search-group"
            role="group"
            aria-label={group.label}
          >
            <p>{group.label}</p>
            <ul class="panel-menu">
              {#each group.options as option (option.href)}
                <li>
                  <a href={option.href} data-option-link>
                    <Icon name="settings" size={16} />
                    <span>
                      {option.label}
                      {#if option.context}<small>{option.context}</small>{/if}
                    </span>
                  </a>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
        {#if loading}
          <p role="status">Loading agents…</p>
        {:else if unavailable}
          <p role="status">Could not load the latest agent list.</p>
          <ActionButton
            type="button"
            onclick={() => {
              search.querySelector("input")?.focus();
              refresh();
            }}>Retry loading agents</ActionButton
          >
        {:else if !matches.length}
          <p role="status">No matching options.</p>
        {/if}
      </div>
    {/if}
  </form>

  <details
    data-ui="agent-switcher"
    bind:this={switcher}
    ontoggle={() => {
      if (switcher.open) {
        switcherOpened = true;
        refresh();
      }
    }}
  >
    <summary
      bind:this={summary}
      aria-label={current ? `Switch agent, ${current.name}` : "Switch agent"}
    >
      {#if current}
        {#key current.id}
          <AgentAvatar agentId={current.id} name={current.name} small />
        {/key}
      {/if}
      <span data-ui="agent-switcher-name"
        >{current?.name ?? "Switch agent"}</span
      >
      <Icon name="chevron" size={16} />
    </summary>
    {#if switcherOpened}
      <div data-ui="agent-header-popover">
        {#if agents.length}
          {@render agentLinks(agents, section)}
        {:else}
          {@render directoryStatus("No agents yet.")}
        {/if}
      </div>
    {/if}
  </details>
</div>
