<script lang="ts">
  export interface Slice {
    key: string;
    value: number;
  }
  let {
    slices,
    label,
    detail,
  }: { slices: Slice[]; label: string; detail: string } = $props();
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let total = $derived(slices.reduce((sum, item) => sum + item.value, 0));
  let arcs = $derived.by(() => {
    let offset = 0;
    return slices.map((item, index) => {
      const length = total ? (item.value / total) * circumference : 0;
      const arc = { key: item.key, index, length, offset };
      offset += length;
      return arc;
    });
  });
</script>

<div data-ui="usage-donut">
  <svg viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r={radius} data-track="true" />
    {#each arcs as arc (arc.key)}
      {#if arc.length > 0}<circle
          cx="50"
          cy="50"
          r={radius}
          data-slice={arc.index}
          stroke-dasharray={`${Math.max(arc.length - 1.5, 0.5)} ${circumference}`}
          stroke-dashoffset={-arc.offset}
        />{/if}
    {/each}
  </svg>
  <div><strong>{label}</strong><small>{detail}</small></div>
</div>
