<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";
  let {
    checked = $bindable(false),
    group = $bindable(),
    value,
    indeterminate = false,
    children,
    ...rest
  }: Omit<HTMLInputAttributes, "type" | "value" | "checked" | "children"> & {
    checked?: boolean;
    group?: T[];
    value?: T;
    indeterminate?: boolean;
    children: Snippet;
  } = $props();
  let input: HTMLInputElement;
  $effect(() => {
    input.indeterminate = indeterminate;
  });
</script>

<label data-ui="checkbox"
  ><span data-ui="checkbox-box"
    ><input
      {...rest}
      type="checkbox"
      bind:this={input}
      value={value === undefined ? undefined : String(value)}
      checked={group ? group.includes(value as T) : checked}
      onchange={(event) => {
        const next = event.currentTarget.checked;
        if (group)
          group = next
            ? [...group, value as T]
            : group.filter((item: T) => item !== value);
        else checked = next;
      }}
    /><Icon name={indeterminate ? "minus" : "check"} size={14} /></span
  >{@render children()}</label
>
