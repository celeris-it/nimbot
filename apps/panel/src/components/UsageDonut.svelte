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
  const strokeWidth = 13;
  const segmentGap = 4;
  const circumference = 2 * Math.PI * radius;
  let activeSlices = $derived(
    slices
      .map((slice, index) => ({ ...slice, index }))
      .filter((slice) => slice.value > 0),
  );
  let total = $derived(activeSlices.reduce((sum, item) => sum + item.value, 0));
  let arcs = $derived.by(() => {
    let offset = 0;
    return activeSlices.map(({ key, index, value }) => {
      const length = (value / total) * circumference;
      const width = Math.min(strokeWidth, length / 2);
      // Leave room for the round caps and scale the gap for very small slices.
      const trim = width + Math.min(segmentGap, length / 4);
      const arc = {
        key,
        index,
        width,
        length: length - trim,
        start: offset + trim / 2,
      };
      offset += length;
      return arc;
    });
  });
</script>

<div data-ui="usage-donut">
  <svg viewBox="0 0 100 100" aria-hidden="true">
    {#if !arcs.length}
      <circle
        cx="50"
        cy="50"
        r={radius}
        stroke-width={strokeWidth}
        data-track="true"
      />
    {/if}
    {#each arcs as arc (arc.key)}
      <circle
        cx="50"
        cy="50"
        r={radius}
        data-slice={arc.index}
        stroke-width={arc.width}
        stroke-linecap="round"
        stroke-dasharray={arcs.length === 1
          ? undefined
          : `${arc.length} ${circumference}`}
        stroke-dashoffset={arcs.length === 1 ? undefined : -arc.start}
      />
    {/each}
  </svg>
  <div><strong>{label}</strong><small>{detail}</small></div>
</div>
