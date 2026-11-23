<script lang="ts">
  import { ActionButton, Icon, PasswordField } from "./components/index.js";
  import type { McpAgentDefinition } from "../../server/src/panel/panel-contracts.js";
  let {
    definitions,
    busy,
    refresh,
    action,
  }: {
    definitions: McpAgentDefinition[] | undefined;
    refresh: () => void;
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

<section aria-labelledby="mcp-access">
  <div class="settings-section-description">
    <h2 id="mcp-access" tabindex="-1" class="card-title">
      <Icon name="plug" size={20} />MCP integrations
    </h2>
  </div>
  <div class="panel-card">
    <ActionButton class="self-start" href="/mcp">MCP catalog</ActionButton>
    {#if !definitions}
      <p role="status">MCP integrations unavailable.</p>
      <ActionButton class="self-start" onclick={refresh}
        ><Icon name="refresh" size={16} />Retry loading MCP integrations</ActionButton
      >
    {:else if definitions.length === 0}
      <p>No integrations in the catalog.</p>
    {:else}
      {#each definitions as definition (definition.id)}
        <section
          data-ui="agent-mcp-integration"
          aria-labelledby={`integration-${definition.id}`}
        >
          <h3 id={`integration-${definition.id}`}>{definition.label}</h3>
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
              <a href={`/mcp/${encodeURIComponent(definition.id)}`}
                >Review tools</a
              >
            </p>
          {/if}
          {#if definition.granted}
            <form
              aria-describedby="form-error"
              aria-busy={busy}
              onsubmit={(event) => save(event, definition)}
            >
              <label for={`credential-${definition.id}`}
                >Bearer credential</label
              >
              <PasswordField
                id={`credential-${definition.id}`}
                bind:value={tokens[definition.id]}
                maxlength={4096}
                autocomplete="new-password"
                required
              />
              <ActionButton variant="primary" disabled={busy} type="submit"
                >{definition.hasCredential
                  ? "Replace credential"
                  : "Save credential"}</ActionButton
              >
            </form>
            {#if definition.hasCredential}
              <ActionButton
                disabled={busy}
                onclick={() => action(definition, "credential", null)}
                >Remove credential</ActionButton
              >
            {/if}
            <ActionButton
              disabled={busy}
              onclick={() => {
                delete tokens[definition.id];
                return action(definition, "revoke");
              }}>Revoke access</ActionButton
            >
          {:else}
            <ActionButton
              disabled={busy}
              onclick={() => action(definition, "grant")}
              >Grant access</ActionButton
            >
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</section>
