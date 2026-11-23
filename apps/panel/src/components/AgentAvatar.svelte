<script lang="ts">
  let {
    agentId,
    name,
    small = false,
  }: { agentId: string; name: string; small?: boolean } = $props();
  let loaded = $state(false);
  let failed = $state(false);
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

<span class="agent-avatar" data-small={small} aria-hidden="true">
  {#if !loaded}<span>{initials}</span>{/if}
  {#if !failed}
    <img
      src={`/api/agents/${encodeURIComponent(agentId)}/avatar`}
      alt=""
      class="size-full rounded-full object-cover"
      hidden={!loaded}
      onload={() => (loaded = true)}
      onerror={() => {
        loaded = false;
        failed = true;
      }}
    />
  {/if}
</span>
