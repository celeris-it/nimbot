<script lang="ts">
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

<div class="tabs tabs-box" role="group" aria-label={label}>
  {#each options as option (option.value)}<button
      type="button"
      class="tab"
      class:tab-active={value === option.value}
      aria-pressed={value === option.value}
      onclick={() => (value = option.value)}
      >{option.label}{#if option.count !== undefined}<span>{option.count}</span
        >{/if}</button
    >{/each}
</div>
