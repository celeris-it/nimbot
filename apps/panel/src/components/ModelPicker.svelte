<script lang="ts">
  import { tick } from "svelte";
  import type {
    AgentModels,
    ModelReference,
  } from "../../../server/src/providers/usage-contracts.js";
  import Icon from "./Icon.svelte";

  let {
    models,
    value = $bindable(),
    disabled,
  }: {
    models: AgentModels["models"];
    value: ModelReference | null;
    disabled: boolean;
  } = $props();

  interface Option {
    id: string;
    label: string;
    model: ModelReference | null;
    searchText: string;
  }

  const id = $props.id();
  const automatic: Option = {
    id: `${id}-automatic`,
    label: "Automatic",
    model: null,
    searchText: "automatic",
  };
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let search = $state<HTMLInputElement>();
  let list = $state<HTMLDivElement>();
  let open = $state(false);
  let above = $state(false);
  let query = $state("");
  let activeIndex = $state(-1);
  let groups = $derived.by(() => {
    const providers: Record<string, Option[]> = Object.create(null);
    for (const [index, model] of models.entries()) {
      const options = (providers[model.providerId] ??= []);
      options.push({
        id: `${id}-option-${index}`,
        label: model.name,
        model,
        searchText:
          `${model.name} ${model.providerId}/${model.modelId}`.toLowerCase(),
      });
    }
    return Object.entries(providers).map(([provider, options]) => ({
      provider,
      options,
    }));
  });
  let currentModel = $derived(models.find((model) => matches(model, value)));
  let term = $derived(query.trim().toLowerCase());
  let showAutomatic = $derived(automatic.searchText.includes(term));
  let visibleGroups = $derived(
    groups
      .map(({ provider, options }) => ({
        provider,
        options: options.filter(({ searchText }) => searchText.includes(term)),
      }))
      .filter(({ options }) => options.length),
  );
  let visibleOptions = $derived([
    ...(showAutomatic ? [automatic] : []),
    ...visibleGroups.flatMap(({ options }) => options),
  ]);
  let active = $derived(visibleOptions[activeIndex]);

  function matches(
    model: ModelReference | null,
    choice: ModelReference | null,
  ) {
    return (
      model?.providerId === choice?.providerId &&
      model?.modelId === choice?.modelId
    );
  }

  function close(restoreFocus = false) {
    open = false;
    if (restoreFocus) trigger.focus();
  }

  async function toggle() {
    if (open) {
      close();
      return;
    }
    const bounds = trigger.getBoundingClientRect();
    const viewport = window.innerHeight;
    const below = viewport - bounds.bottom;
    above = below < Math.min(320, viewport * 0.42) + 64 && bounds.top > below;
    query = "";
    activeIndex = visibleOptions.findIndex(({ model }) =>
      matches(model, value),
    );
    open = true;
    await tick();
    if (open) {
      search?.focus({ preventScroll: true });
      scrollToActive();
    }
  }

  function choose(option: Option) {
    if (disabled) return;
    value = option.model;
    close(true);
  }

  function scrollToActive() {
    if (!active || !list) return;
    const row = document.getElementById(active.id)?.getBoundingClientRect();
    if (!row) return;
    const bounds = list.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
    if (row.bottom > bounds.bottom)
      list.scrollTop += row.bottom - bounds.bottom;
  }

  async function handleKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) choose(active);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const last = visibleOptions.length - 1;
      activeIndex =
        event.key === "ArrowDown"
          ? Math.min(activeIndex + 1, last)
          : activeIndex < 0
            ? last
            : Math.max(activeIndex - 1, 0);
      await tick();
      if (open) scrollToActive();
    }
  }

  function updateSearch(event: Event & { currentTarget: HTMLInputElement }) {
    query = event.currentTarget.value;
    activeIndex = visibleOptions.length ? 0 : -1;
    if (list) list.scrollTop = 0;
  }

  function dismissOutside(event: PointerEvent) {
    if (open && event.target instanceof Node && !root.contains(event.target))
      close();
  }

  function dismissOnFocusOut(event: FocusEvent) {
    if (
      open &&
      event.relatedTarget instanceof Node &&
      !root.contains(event.relatedTarget)
    )
      close();
  }
</script>

<svelte:window onpointerdown={dismissOutside} />

{#snippet optionRow(option: Option)}
  <button
    type="button"
    role="option"
    id={option.id}
    tabindex="-1"
    aria-selected={matches(option.model, value)}
    class="option"
    class:active={active?.id === option.id}
    onmousedown={(event) => event.preventDefault()}
    onclick={() => choose(option)}
  >
    <span class="option-icon">
      <Icon name={option.model ? "bot" : "settings"} size={17} />
    </span>
    <span class="option-text">
      <span>{option.label}</span>
      {#if option.model}<small>{option.model.modelId}</small>{/if}
    </span>
    {#if matches(option.model, value)}
      <span class="check"><Icon name="check" size={17} /></span>
    {/if}
  </button>
{/snippet}

<div class="picker" bind:this={root} onfocusout={dismissOnFocusOut}>
  <label id={`${id}-label`} for={`${id}-trigger`}>Model for new turns</label>
  <div class="anchor">
    <button
      type="button"
      id={`${id}-trigger`}
      class="panel-input trigger"
      bind:this={trigger}
      aria-labelledby={`${id}-label ${id}-value`}
      aria-expanded={open}
      aria-controls={open ? `${id}-popover` : undefined}
      onclick={toggle}
      onkeydown={(event) => {
        if (open && event.key === "Escape") close(true);
      }}
      {disabled}
    >
      <span id={`${id}-value`} class="option-text">
        {#if currentModel}
          <span>{currentModel.name}</span>
          <small>{currentModel.providerId}/{currentModel.modelId}</small>
        {:else if value}
          {value.providerId}/{value.modelId} (Unavailable)
        {:else}
          {automatic.label}
        {/if}
      </span>
      <span class="chevron"><Icon name="chevron" size={16} /></span>
    </button>
    {#if open}
      <div class="popover" class:above id={`${id}-popover`}>
        <div class="search">
          <Icon name="search" size={17} />
          <input
            type="text"
            role="combobox"
            aria-label="Search models"
            aria-autocomplete="list"
            aria-controls={`${id}-list`}
            aria-expanded="true"
            aria-activedescendant={active?.id}
            placeholder="Search models…"
            autocomplete="off"
            bind:this={search}
            value={query}
            oninput={updateSearch}
            onkeydown={handleKey}
          />
        </div>
        <div
          id={`${id}-list`}
          class="results"
          role="listbox"
          tabindex="-1"
          aria-label="Models"
          bind:this={list}
        >
          {#if showAutomatic}
            {@render optionRow(automatic)}
          {/if}
          {#each visibleGroups as { provider, options } (provider)}
            <div role="group" aria-label={provider} class="provider">
              <div aria-hidden="true" class="provider-label">{provider}</div>
              {#each options as option (option.id)}
                {@render optionRow(option)}
              {/each}
            </div>
          {/each}
        </div>
        {#if !visibleOptions.length}
          <div class="empty" role="status">No matching models</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .picker {
    display: grid;
    gap: 0.8rem;
    width: min(100%, 28rem);
    min-width: 0;
  }
  .anchor {
    position: relative;
  }
  .trigger {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    min-width: 0;
    min-height: 44px;
    text-align: start;
    overflow-wrap: anywhere;
  }
  .chevron {
    display: inline-flex;
    color: var(--color-muted);
    transform: rotate(90deg);
  }
  .trigger[aria-expanded="true"] .chevron {
    transform: rotate(-90deg);
  }
  .popover {
    position: absolute;
    z-index: 3;
    inset-inline: 0;
    top: calc(100% + 0.4rem);
    padding: 0.5rem;
    border: 1px solid var(--color-base-300);
    border-radius: 1rem;
    background: var(--color-base-200);
    box-shadow: 0 0.8rem 2rem rgb(0 0 0 / 35%);
  }
  .popover.above {
    top: auto;
    bottom: calc(100% + 0.4rem);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0 0.65rem;
    margin-bottom: 0.35rem;
    border: 1px solid var(--color-field-border);
    border-radius: 0.65rem;
    color: var(--color-muted);
    background: var(--color-base-100);
  }
  .search:focus-within {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  .search input {
    width: 100%;
    min-width: 0;
    min-height: 42px;
    color: var(--color-base-content);
    outline: none;
  }
  .search input::placeholder {
    color: var(--color-muted);
  }
  .results {
    max-height: min(20rem, 42dvh);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .provider {
    border-top: 1px solid var(--color-base-300);
    padding-top: 0.35rem;
  }
  .provider-label,
  .empty {
    padding: 0.3rem 0.65rem;
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  .provider-label {
    font-size: 0.72rem;
    font-weight: 700;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    min-height: 44px;
    padding: 0.3rem 0.65rem;
    border-radius: 0.55rem;
    text-align: start;
  }
  .option:hover,
  .option.active {
    background: var(--color-neutral);
  }
  .option[aria-selected="true"] {
    background: var(--color-base-100);
  }
  .option.active {
    outline: 1px solid var(--color-primary);
    outline-offset: -1px;
  }
  .option-text {
    display: grid;
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .option-icon,
  .option-text small {
    color: var(--color-muted);
  }
  .check {
    color: var(--color-primary);
  }
</style>
