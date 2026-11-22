<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLSelectAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";
  let {
    value = $bindable(),
    children,
    class: className,
    ...rest
  }: Omit<HTMLSelectAttributes, "value"> & {
    value?: unknown;
    children: Snippet;
  } = $props();
</script>

<span data-ui="select"
  ><select {...rest} class={["panel-select", className]} bind:value
    >{@render children()}</select
  ><Icon name="chevronDown" size={16} /></span
>
