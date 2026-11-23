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
    id,
    label,
    tone = "neutral",
  }: { id?: string; label: string; tone?: keyof typeof statusIcons } = $props();
</script>

<span {id} class="panel-badge" data-ui="status" data-tone={tone}>
  <Icon name={statusIcons[tone]} size={12} />{label}
</span>
