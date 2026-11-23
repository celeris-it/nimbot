<script lang="ts">
  import type { Snippet } from "svelte";
  import type {
    HTMLAnchorAttributes,
    HTMLAttributes,
    HTMLButtonAttributes,
  } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.js";

  const variants = {
    default: undefined,
    primary: "panel-button-primary",
    danger: "panel-button-danger",
    warning: "panel-button-warning",
    info: "panel-button-info",
    ghost: "panel-button-ghost",
    plain: undefined,
  } as const;

  type Props = HTMLAttributes<HTMLElement> &
    Pick<HTMLAnchorAttributes, "href" | "target" | "rel" | "download"> &
    Pick<
      HTMLButtonAttributes,
      "type" | "disabled" | "form" | "name" | "value"
    > & {
      children?: Snippet;
      variant?: keyof typeof variants;
      icon?: IconName;
      iconOnly?: boolean;
      element?: HTMLButtonElement;
    };

  let {
    children,
    href,
    target,
    rel,
    download,
    onclick,
    disabled,
    variant = "default",
    icon,
    iconOnly,
    type = "button",
    form,
    name,
    value,
    class: className,
    tabindex,
    "aria-disabled": ariaDisabled,
    element = $bindable(),
    ...rest
  }: Props = $props();

  let classes = $derived([
    variant !== "plain" && "panel-button",
    variants[variant],
    iconOnly && "panel-button-icon",
    className,
  ]);
</script>

{#snippet content()}
  {#if icon}<Icon name={icon} />{/if}
  {@render children?.()}
{/snippet}

{#if href != null}
  <a
    {...rest}
    class={classes}
    {href}
    {target}
    {rel}
    {download}
    aria-disabled={disabled || ariaDisabled}
    tabindex={disabled ? -1 : tabindex}
    onclick={(event) => {
      if (disabled) event.preventDefault();
      else onclick?.(event);
    }}>{@render content()}</a
  >
{:else}
  <button
    {...rest}
    class={classes}
    bind:this={element}
    {type}
    {disabled}
    {form}
    {name}
    {value}
    {tabindex}
    aria-disabled={ariaDisabled}
    {onclick}>{@render content()}</button
  >
{/if}
