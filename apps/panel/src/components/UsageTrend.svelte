<script lang="ts">
  let {
    current,
    previous,
    caption,
  }: { current: number[]; previous: number[]; caption: string } = $props();
  const width = 600;
  const height = 160;
  const pad = 8;
  const cumulative = (values: number[]) => {
    let sum = 0;
    return values.map((value) => (sum += value));
  };
  let now = $derived(cumulative(current));
  let before = $derived(cumulative(previous));
  let peak = $derived(Math.max(...now, ...before, 0));
  const point = (values: number[], index: number, top: number) => ({
    x: (index / Math.max(values.length - 1, 1)) * width,
    y: height - pad - (top ? (values[index]! / top) * (height - pad * 2) : 0),
  });
  // Smooth curve through points using horizontal-tangent Béziers.
  const curve = (values: number[]) => {
    const points = values.map((_, index) => point(values, index, peak));
    return points
      .map((p, i) => {
        if (i === 0) return `M${p.x},${p.y}`;
        const q = points[i - 1]!;
        const mid = (q.x + p.x) / 2;
        return `C${mid},${q.y} ${mid},${p.y} ${p.x},${p.y}`;
      })
      .join(" ");
  };
  let line = $derived(curve(now));
  let end = $derived(point(now, now.length - 1, peak));
</script>

<div data-ui="usage-trend" role="img" aria-label={caption}>
  <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
    {#if before.length}<path d={curve(before)} data-line="previous" />{/if}
    <path d={line} data-line="current" />
  </svg>
  <span
    data-ui="trend-dot"
    style:left={`${(end.x / width) * 100}%`}
    style:top={`${(end.y / height) * 100}%`}
  ></span>
</div>
