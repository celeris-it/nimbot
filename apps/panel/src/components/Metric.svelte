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

<div class="stat">
  <div class="stat-title">
    {label}{#if icon}<Icon name={icon} size={16} />{/if}
  </div>
  <div class="stat-value">{value}</div>
  {#if description}<div class="stat-desc">{description}</div>{/if}
</div>
