<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";
  let {
    value = $bindable(),
    disabled,
    ...rest
  }: Omit<HTMLInputAttributes, "value" | "type"> & {
    value?: string | null;
  } = $props();
  let visible = $state(false);
</script>

<div class="panel-input" data-ui="field-group">
  <input
    {...rest}
    {disabled}
    type={visible ? "text" : "password"}
    bind:value
  /><button
    type="button"
    data-ui="field-action"
    aria-label={visible ? "Hide value" : "Show value"}
    aria-pressed={visible}
    {disabled}
    onclick={() => (visible = !visible)}
    ><Icon name={visible ? "eyeOff" : "eye"} size={17} /></button
  >
</div>
