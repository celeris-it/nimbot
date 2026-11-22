<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.js";
  let {
    children,
    href,
    onclick,
    disabled = false,
    primary = false,
    icon,
    type = "button",
  }: {
    children: Snippet;
    href?: string;
    onclick?: (event: MouseEvent) => void;
    disabled?: boolean;
    primary?: boolean;
    icon?: IconName;
    type?: "button" | "submit";
  } = $props();
</script>

{#if href}
  <a
    class="panel-button"
    class:panel-button-primary={primary}
    {href}
    aria-disabled={disabled || undefined}
    tabindex={disabled ? -1 : undefined}
    onclick={(event) => {
      if (disabled) event.preventDefault();
      else onclick?.(event);
    }}
    >{#if icon}<Icon name={icon} />{/if}{@render children()}</a
  >
{:else}
  <button
    class="panel-button"
    class:panel-button-primary={primary}
    {type}
    {disabled}
    {onclick}
    >{#if icon}<Icon name={icon} />{/if}{@render children()}</button
  >
{/if}
