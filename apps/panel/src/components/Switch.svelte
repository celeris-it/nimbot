<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  let {
    checked = $bindable(false),
    children,
    ...rest
  }: Omit<HTMLInputAttributes, "type" | "checked" | "children" | "role"> & {
    checked?: boolean;
    children: Snippet;
  } = $props();
</script>

<label data-ui="switch"
  ><span data-ui="switch-track"
    ><input {...rest} type="checkbox" role="switch" bind:checked /></span
  >{@render children()}</label
>
