<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  let {
    caption,
    columns,
    rows,
    row,
    rowKey,
    empty = "No records yet.",
  }: {
    caption: string;
    columns: string[];
    rows: T[];
    row: Snippet<[T]>;
    rowKey: (item: T) => string | number;
    empty?: string;
  } = $props();
</script>

<!-- Keyboard focus allows native arrow-key scrolling when the table overflows. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div data-ui="table-scroll" tabindex="0" role="region" aria-label={caption}>
  <table class="panel-table">
    <caption>{caption}</caption><thead
      ><tr
        >{#each columns as column (column)}<th scope="col">{column}</th
          >{/each}</tr
      ></thead
    ><tbody
      >{#each rows as item (rowKey(item))}<tr>{@render row(item)}</tr>{:else}<tr
          ><td colspan={columns.length}>{empty}</td></tr
        >{/each}</tbody
    >
  </table>
</div>
