<script lang="ts">
  import { onMount } from "svelte";
  import { Icon } from "./components/index.js";

  let {
    links,
    agentId,
    currentView,
  }: {
    links: { view: string; label: string }[];
    agentId: string;
    currentView: string | undefined;
  } = $props();
  let nav: HTMLElement;
  let bar: HTMLDivElement;
  let measurement: HTMLDivElement;
  let more: HTMLDetailsElement | undefined = $state();
  let moreButton: HTMLElement | undefined = $state();
  let visibleCount = $state(1);
  let overflow = $derived(links.slice(visibleCount));
  let base = $derived(`/agents/${encodeURIComponent(agentId)}`);

  function fitLinks() {
    const style = getComputedStyle(bar);
    const barInsets =
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.borderRightWidth);
    const available = nav.getBoundingClientRect().width - barInsets;
    const widths = Array.from(
      measurement.children,
      (item) => item.getBoundingClientRect().width,
    );
    const moreWidth = widths.pop() ?? 0;
    if (widths.reduce((total, width) => total + width, 0) <= available) {
      visibleCount = widths.length;
      return;
    }
    let remaining = available - moreWidth;
    let count = 0;
    for (const width of widths) {
      if (width > remaining) break;
      remaining -= width;
      count++;
    }
    visibleCount = Math.max(1, count);
  }

  onMount(() => {
    fitLinks();
    const observer = new ResizeObserver(fitLinks);
    observer.observe(nav);
    observer.observe(measurement);
    return () => observer.disconnect();
  });

  function dismissOutside(event: MouseEvent) {
    if (
      more?.open &&
      event.target instanceof Node &&
      !more.contains(event.target)
    )
      more.open = false;
  }

  function dismissOnFocusOut(event: FocusEvent) {
    if (
      more?.open &&
      event.relatedTarget instanceof Node &&
      !more.contains(event.relatedTarget)
    )
      more.open = false;
  }

  function dismissWithEscape(event: KeyboardEvent) {
    if (event.key === "Escape" && more?.open) {
      more.open = false;
      moreButton?.focus();
    }
  }
</script>

<svelte:window onclick={dismissOutside} onkeydown={dismissWithEscape} />

{#snippet linkItem(link: (typeof links)[number])}
  <a
    data-ui="agent-nav-link"
    href={`${base}/${link.view}`}
    aria-current={currentView === link.view ? "page" : undefined}
    >{link.label}</a
  >
{/snippet}

<nav bind:this={nav} aria-label="Agent navigation" data-ui="agent-navigation">
  <div
    data-ui="agent-nav-bar"
    data-overflow={overflow.length > 0}
    bind:this={bar}
  >
    {#each links.slice(0, visibleCount) as link (link.view)}
      {@render linkItem(link)}
    {/each}
    {#if overflow.length}
      <details
        class="dropdown dropdown-end"
        bind:this={more}
        onfocusout={dismissOnFocusOut}
      >
        <summary
          bind:this={moreButton}
          data-ui="agent-nav-more"
          data-current={overflow.some((link) => link.view === currentView)}
          aria-label="More agent options"
        >
          <Icon name="ellipsis" size={20} />
        </summary>
        <ul class="menu dropdown-content">
          {#each overflow as link (link.view)}
            <li>{@render linkItem(link)}</li>
          {/each}
        </ul>
      </details>
    {/if}
  </div>
  <div data-ui="agent-nav-measure" aria-hidden="true">
    <div bind:this={measurement}>
      {#each links as link (link.view)}
        <span data-ui="agent-nav-link">{link.label}</span>
      {/each}
      <span data-ui="agent-nav-more"></span>
    </div>
  </div>
</nav>
