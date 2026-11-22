<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.js";
  let {
    label,
    value,
    description,
    icon,
  }: {
    label: string;
    value: number | string;
    description?: string;
    icon?: IconName;
  } = $props();
</script>

<div data-ui="metric">
  <div class="metric-label">
    {label}{#if icon}<Icon name={icon} size={16} />{/if}
  </div>
  <div class="metric-value">{value}</div>
  {#if description}<div class="metric-description">{description}</div>{/if}
</div>
