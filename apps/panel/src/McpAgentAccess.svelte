<script lang="ts">
  import type { McpAgentDefinition } from "../../server/src/panel-contracts.js";
  let {
    agent,
    definitions,
    busy,
    action,
  }: {
    agent: { id: string; name: string };
    definitions: McpAgentDefinition[];
    busy: boolean;
    action: (
      definition: McpAgentDefinition,
      command: "grant" | "revoke" | "credential",
      token?: string | null,
    ) => Promise<void>;
  } = $props();
  let tokens = $state<Record<string, string>>({});

  async function save(event: SubmitEvent, definition: McpAgentDefinition) {
    event.preventDefault();
    const token = tokens[definition.id];
    if (busy || !token) return;
    delete tokens[definition.id];
    await action(definition, "credential", token);
  }
</script>

<h1 tabindex="-1">MCP access for {agent.name}</h1>
<a class="btn" href={`/agents/${encodeURIComponent(agent.id)}/setup`}
  >Back to agent</a
>
<a class="btn" href="/mcp">MCP catalog</a>
{#if definitions.length === 0}
  <p>No integrations in the catalog.</p>
{:else}
  {#each definitions as definition (definition.id)}
    <section class="card" aria-labelledby={`integration-${definition.id}`}>
      <h2 id={`integration-${definition.id}`}>{definition.label}</h2>
      <p>
        {definition.granted ? "Access granted" : "Access withheld"} · {definition.enabled
          ? "Enabled in catalog"
          : "Disabled in catalog"}
      </p>
      {#if definition.blockedTools?.length}
        <p>
          {definition.blockedTools.length} tool{definition.blockedTools
            .length === 1
            ? ""
            : "s"} disabled pending review.
          <a href={`/mcp/${encodeURIComponent(definition.id)}`}>Review tools</a>
        </p>
      {/if}
      {#if definition.granted}
        <form aria-busy={busy} onsubmit={(event) => save(event, definition)}>
          <label for={`credential-${definition.id}`}>Bearer credential</label>
          <input
            class="input"
            id={`credential-${definition.id}`}
            type="password"
            bind:value={tokens[definition.id]}
            maxlength="4096"
            autocomplete="new-password"
            required
          />
          <button class="btn" disabled={busy} type="submit"
            >{definition.hasCredential
              ? "Replace credential"
              : "Save credential"}</button
          >
        </form>
        {#if definition.hasCredential}
          <button
            class="btn"
            disabled={busy}
            onclick={() => action(definition, "credential", null)}
            >Remove credential</button
          >
        {/if}
        <button
          class="btn"
          disabled={busy}
          onclick={() => {
            delete tokens[definition.id];
            return action(definition, "revoke");
          }}>Revoke access</button
        >
      {:else}
        <button
          class="btn"
          disabled={busy}
          onclick={() => action(definition, "grant")}>Grant access</button
        >
      {/if}
    </section>
  {/each}
{/if}
