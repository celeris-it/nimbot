<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.js";

  const statusIcons = {
    neutral: "minus",
    good: "check",
    warning: "alert",
    danger: "close",
  } satisfies Record<string, IconName>;

  let {
    label,
    tone = "neutral",
  }: { label: string; tone?: keyof typeof statusIcons } = $props();
</script>

<span class="panel-badge" data-ui="status" data-tone={tone}>
  <Icon name={statusIcons[tone]} size={12} />{label}
</span>
