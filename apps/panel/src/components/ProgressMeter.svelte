<script lang="ts">
  let {
    label,
    value,
    max,
    description,
  }: { label: string; value: number; max: number; description?: string } =
    $props();
  let safeMax = $derived(Math.max(1, max));
  let safeValue = $derived(Math.min(safeMax, Math.max(0, value)));
</script>

<div data-ui="meter">
  <div><span>{label}</span><span>{value} / {max}</span></div>
  <progress
    class="progress progress-primary"
    aria-label={label}
    value={safeValue}
    max={safeMax}
  ></progress>{#if description}<p>{description}</p>{/if}
</div>
