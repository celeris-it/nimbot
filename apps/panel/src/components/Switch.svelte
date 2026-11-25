<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  let {
    checked = $bindable(false),
    onchange,
    children,
    ...rest
  }: Omit<HTMLInputAttributes, "type" | "checked" | "children" | "role"> & {
    checked?: boolean;
    children: Snippet;
  } = $props();
</script>

<label data-ui="switch"
  ><span data-ui="switch-track"
    ><input
      {...rest}
      type="checkbox"
      role="switch"
      {checked}
      onchange={(event) => {
        if (onchange) onchange(event);
        else checked = event.currentTarget.checked;
      }}
    /></span
  >{@render children()}</label
>
