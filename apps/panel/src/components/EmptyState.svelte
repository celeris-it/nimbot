<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.js";
  let {
    title,
    description,
    actions,
    icon = "bot",
  }: {
    title: string;
    description: string;
    actions?: Snippet;
    icon?: IconName;
  } = $props();
</script>

<div data-ui="empty-state">
  <span data-ui="empty-icon"><Icon name={icon} size={26} /></span>
  <h3>{title}</h3>
  <p>{description}</p>
  {#if actions}<div>{@render actions()}</div>{/if}
</div>
