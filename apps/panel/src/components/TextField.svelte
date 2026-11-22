<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  let {
    value = $bindable(),
    prefix,
    class: className,
    ...rest
  }: Omit<HTMLInputAttributes, "value" | "prefix"> & {
    value?: string | number | null;
    prefix?: string;
  } = $props();
</script>

{#if prefix}
  <div class="panel-input" data-ui="field-group">
    <span data-ui="field-addon">{prefix}</span><input
      {...rest}
      class={className}
      bind:value
    />
  </div>
{:else}
  <input {...rest} class={["panel-input", className]} bind:value />
{/if}
