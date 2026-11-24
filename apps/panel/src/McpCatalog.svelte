<script lang="ts">
  import type {
    McpDefinitionSummary,
    McpExample,
  } from "../../server/src/panel/panel-contracts.js";
  import { ActionButton, StatusBadge, TextField } from "./components/index.js";
  import { messages, translateDescription } from "./i18n/language.js";

  let {
    definitions,
    examples,
  }: {
    definitions: readonly McpDefinitionSummary[];
    examples: readonly McpExample[];
  } = $props();

  let query = $state("");
  const search = $derived(query.trim().toLocaleLowerCase());
  const localizedExamples = $derived(
    examples.map((example) => ({
      ...example,
      description: translateDescription($messages, example.description),
    })),
  );
  const matches = $derived(
    localizedExamples.filter(({ label, description }) =>
      `${label} ${description}`.toLocaleLowerCase().includes(search),
    ),
  );
</script>

<div class="grid gap-6">
  <header data-ui="page-heading" class="flex-wrap">
    <div class="min-w-0">
      <h1 id="mcp-catalog" tabindex="-1">{$messages("MCP catalog")}</h1>
      <p class="mt-2 text-muted">
        {$messages(
          "Add tools here, then grant access from an agent’s Access page.",
        )}
      </p>
    </div>
    <ActionButton variant="primary" icon="plus" href="/mcp/new"
      >{$messages("Add integration")}</ActionButton
    >
  </header>

  <section class="grid gap-2" aria-labelledby="mcp-integrations-heading">
    <h2 id="mcp-integrations-heading" class="text-lg">
      {$messages("Integrations")}
    </h2>
    {#if definitions.length === 0}
      <p
        class="rounded-panel border border-base-300 bg-base-100 px-4 py-3 text-muted"
      >
        {$messages(
          "No integrations yet. Set up an example below or add your own.",
        )}
      </p>
    {:else}
      <ul
        class="divide-y divide-base-300 rounded-panel border border-base-300 bg-base-100"
      >
        {#each definitions as definition (definition.id)}
          <li class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
            <a
              class="inline-flex min-h-11 min-w-0 flex-[1_1_12rem] items-center font-semibold underline underline-offset-4 [overflow-wrap:anywhere]"
              href={`/mcp/${encodeURIComponent(definition.id)}`}
              >{definition.label}</a
            >
            <div class="flex flex-wrap items-center gap-2">
              <StatusBadge
                label={definition.enabled
                  ? $messages("Enabled")
                  : $messages("Disabled")}
                tone={definition.enabled ? "good" : "neutral"}
              />
              {#if definition.blockedTools?.length}
                <StatusBadge
                  label={$messages("Review needed")}
                  tone="warning"
                />
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="grid gap-3" aria-labelledby="mcp-examples-heading">
    <div
      class="grid gap-2 @min-[44rem]:grid-cols-[1fr_minmax(0,20rem)] @min-[44rem]:items-center"
    >
      <h2 id="mcp-examples-heading" class="text-lg">{$messages("Examples")}</h2>
      <div class="grid max-w-md gap-1">
        <label for="mcp-example-search" class="font-semibold"
          >{$messages("Search examples")}</label
        >
        <TextField
          id="mcp-example-search"
          type="search"
          autocomplete="off"
          bind:value={query}
        />
      </div>
    </div>
    <p
      role="status"
      class="text-muted"
      class:sr-only={!search && matches.length > 0}
    >
      {#if matches.length === 0}
        {$messages(
          "No matching examples. Try a different search or clear the field.",
        )}
      {:else if search}
        {matches.length === 1
          ? $messages("1 matching example")
          : $messages("{0} matching examples", matches.length)}
      {/if}
    </p>
    {#if matches.length}
      <ul class="grid min-w-0 gap-2 @min-[44rem]:grid-cols-2">
        {#each matches as example (example.id)}
          <li
            class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-base-300 bg-base-100 px-4 py-3 [--button-border:var(--color-field-border)]"
          >
            <div class="min-w-0 flex-[1_1_11rem]">
              <h3 class="text-base">{example.label}</h3>
              <p class="mt-0.5 text-muted">
                {example.description}
              </p>
            </div>
            <ActionButton
              href={`/mcp/new?example=${encodeURIComponent(example.id)}`}
              aria-label={$messages("Set up {0}", example.label)}
              >{$messages("Set up")}</ActionButton
            >
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  p {
    max-inline-size: none;
    line-height: 1.5;
  }
</style>
