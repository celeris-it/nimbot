<script lang="ts">
  let { name, small = false }: { name: string; small?: boolean } = $props();
  let initials = $derived(
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() || "A",
  );
</script>

<div class="avatar avatar-placeholder" data-small={small} aria-hidden="true">
  <div><span>{initials}</span></div>
</div>
