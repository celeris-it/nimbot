<script lang="ts">
  import { messages } from "../i18n/language.js";
  import ActionButton from "./ActionButton.svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";
  let {
    value = $bindable(),
    unit,
    disabled,
    ...rest
  }: Omit<HTMLInputAttributes, "value" | "type"> & {
    value?: number | null;
    unit?: string;
  } = $props();
  let input: HTMLInputElement;

  function step(direction: 1 | -1) {
    if (direction > 0) input.stepUp();
    else input.stepDown();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
</script>

<div class="panel-input" data-ui="field-group" data-variant="stepper">
  <span data-ui="stepper-buttons"
    ><ActionButton
      variant="plain"
      type="button"
      tabindex={-1}
      aria-label={$messages("Increase")}
      {disabled}
      onclick={() => step(1)}><Icon name="chevronUp" size={12} /></ActionButton
    ><ActionButton
      variant="plain"
      type="button"
      tabindex={-1}
      aria-label={$messages("Decrease")}
      {disabled}
      onclick={() => step(-1)}
      ><Icon name="chevronDown" size={12} /></ActionButton
    ></span
  ><input
    {...rest}
    {disabled}
    type="number"
    bind:this={input}
    bind:value
  />{#if unit}<span data-ui="field-unit">{unit}</span>{/if}
</div>
