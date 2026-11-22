<script lang="ts">
  let {
    label,
    tone = "neutral",
  }: { label: string; tone?: "neutral" | "good" | "warning" | "danger" } =
    $props();
</script>

<span class="panel-badge" data-ui="status" data-tone={tone}>{label}</span>
