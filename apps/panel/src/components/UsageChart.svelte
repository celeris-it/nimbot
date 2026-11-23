<script lang="ts">
  export interface Bar {
    key: string;
    label: string;
    value: number;
    title: string;
  }
  let { bars, caption }: { bars: Bar[]; caption: string } = $props();
  let peak = $derived(Math.max(...bars.map((bar) => bar.value), 0));
</script>

<div
  data-ui="usage-bars"
  data-dense={bars.length > 10 || undefined}
  role="img"
  aria-label={caption}
>
  {#each bars as bar, index (bar.key)}
    <div data-ui="usage-bar" title={bar.title}>
      <div data-ui="usage-bar-track">
        <div
          data-ui="usage-bar-fill"
          data-empty={bar.value === 0}
          style:height={`${peak ? Math.max((bar.value / peak) * 100, bar.value ? 6 : 0) : 0}%`}
        ></div>
      </div>
      <small data-hidden={bars.length > 10 && index % 5 !== 0}
        >{bar.label}</small
      >
    </div>
  {/each}
</div>
