<script lang="ts">
  import { numberFormat } from "../i18n/language.js";
  import ActionButton from "./ActionButton.svelte";
  let {
    label,
    options,
    value = $bindable(""),
  }: {
    label: string;
    options: Array<{ value: string; label: string; count?: number }>;
    value?: string;
  } = $props();
</script>

<div class="fleet-filters" role="group" aria-label={label}>
  {#each options as option (option.value)}<ActionButton
      variant="plain"
      type="button"
      class="fleet-filter"
      aria-pressed={value === option.value}
      onclick={() => (value = option.value)}
      >{option.label}{#if option.count !== undefined}<span
          >{$numberFormat.format(option.count)}</span
        >{/if}</ActionButton
    >{/each}
</div>
