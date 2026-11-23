<script lang="ts">
  export interface Ring {
    key: string;
    percent: number;
  }
  let {
    rings,
    label,
    detail,
  }: { rings: Ring[]; label: string; detail: string } = $props();
  const radii = [46, 39, 32, 25];
  const circumference = (radius: number) => 2 * Math.PI * radius;
</script>

<div data-ui="usage-donut" data-rings="true">
  <svg viewBox="0 0 100 100" aria-hidden="true">
    {#each rings.slice(0, radii.length) as ring, index (ring.key)}
      {@const radius = radii[index]!}
      <circle cx="50" cy="50" r={radius} data-track="true" />
      {#if ring.percent > 0}<circle
          cx="50"
          cy="50"
          r={radius}
          data-slice={index}
          stroke-linecap="round"
          stroke-dasharray={`${(Math.min(ring.percent, 100) / 100) * circumference(radius)} ${circumference(radius)}`}
        />{/if}
    {/each}
  </svg>
  <div><strong>{label}</strong><small>{detail}</small></div>
</div>
