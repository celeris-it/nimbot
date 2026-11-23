<script lang="ts" generics="T">
  import { messages } from "../i18n/language.js";
  import type { Snippet } from "svelte";

  let {
    caption,
    columns,
    rows,
    row,
    rowKey,
    empty,
    footer,
  }: {
    caption: string;
    columns: readonly { label: string; numeric?: boolean }[];
    rows: T[];
    row: Snippet<[T]>;
    rowKey: (item: T) => string | number;
    empty?: string;
    footer?: Snippet;
  } = $props();

  const id = $props.id();
  let viewportWidth = $state(0);
  let tableWidth = $state(0);
  let overflows = $derived(viewportWidth > 0 && tableWidth > viewportWidth);
</script>

<div class="table-panel">
  <div class="table-heading">
    <h3 {id}>{caption}</h3>
    {#if overflows}
      <p id={`${id}-scroll`}>
        {$messages("Scroll horizontally to see all columns.")}
      </p>
    {/if}
  </div>
  {#if rows.length}
    <!-- Keyboard focus allows native arrow-key scrolling when the table overflows. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="table-scroll"
      role="region"
      aria-labelledby={id}
      aria-describedby={overflows ? `${id}-scroll` : undefined}
      tabindex={overflows ? 0 : undefined}
      bind:clientWidth={viewportWidth}
    >
      <table
        class="panel-table"
        aria-labelledby={id}
        bind:offsetWidth={tableWidth}
      >
        <thead>
          <tr>
            {#each columns as column (column.label)}
              <th scope="col" data-numeric={column.numeric}>{column.label}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as item (rowKey(item))}
            <tr>{@render row(item)}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="table-empty" role="status">
      {empty ?? $messages("No records yet.")}
    </p>
  {/if}
  {#if footer}
    <div class="table-footer">{@render footer()}</div>
  {/if}
</div>
