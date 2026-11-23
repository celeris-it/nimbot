<script lang="ts">
  import { messages } from "./i18n/language.js";
  import { Icon } from "./components/index.js";
  import type { IconName } from "./components/icons.js";

  let {
    links,
    agentId,
    currentView,
  }: {
    links: { view: string; label: string; icon: IconName }[];
    agentId: string;
    currentView: string | undefined;
  } = $props();
  let disclosure: HTMLDetailsElement;
  let summary: HTMLElement;
  let current = $derived(links.find((link) => link.view === currentView));
  let base = $derived(`/agents/${encodeURIComponent(agentId)}`);

  function dismissWithEscape(event: KeyboardEvent) {
    if (
      event.key === "Escape" &&
      disclosure.open &&
      event.target instanceof Node &&
      disclosure.contains(event.target)
    ) {
      disclosure.open = false;
      summary.focus();
    }
  }
</script>

<svelte:window onkeydown={dismissWithEscape} />

{#snippet options()}
  <ul class="panel-menu" data-ui="agent-nav-options">
    {#each links as link (link.view)}
      <li>
        <a
          data-ui="agent-nav-link"
          href={`${base}/${link.view}`}
          aria-current={currentView === link.view ? "page" : undefined}
        >
          <Icon name={link.icon} size={16} />
          {link.label}
        </a>
      </li>
    {/each}
  </ul>
{/snippet}

<nav aria-label={$messages("Agent navigation")} data-ui="agent-navigation">
  <div data-ui="agent-nav-sidebar">
    <p>{$messages("Agent sections")}</p>
    {@render options()}
  </div>
  <details bind:this={disclosure}>
    <summary bind:this={summary}>
      {$messages("Agent sections")}{current ? ` · ${current.label}` : ""}
      <Icon name="chevron" size={16} />
    </summary>
    {@render options()}
  </details>
</nav>
