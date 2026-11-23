<script lang="ts">
  import { Icon, PasswordField } from "./components/index.js";
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
    <h2 id="mcp-access" class="card-title">
      <Icon name="plug" size={20} />MCP integrations
    </h2>
  </div>
  <div class="panel-card">
    <a class="panel-button self-start" href="/mcp">MCP catalog</a>
    {#if !definitions}
      <p role="status">MCP integrations unavailable.</p>
      <button class="panel-button self-start" onclick={refresh}
        >Retry loading MCP integrations</button
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
              <button
                class="panel-button panel-button-primary"
                disabled={busy}
                type="submit"
                >{definition.hasCredential
                  ? "Replace credential"
                  : "Save credential"}</button
              >
            </form>
            {#if definition.hasCredential}
              <button
                class="panel-button"
                disabled={busy}
                onclick={() => action(definition, "credential", null)}
                >Remove credential</button
              >
            {/if}
            <button
              class="panel-button"
              disabled={busy}
              onclick={() => {
                delete tokens[definition.id];
                return action(definition, "revoke");
              }}>Revoke access</button
            >
          {:else}
            <button
              class="panel-button"
              disabled={busy}
              onclick={() => action(definition, "grant")}>Grant access</button
            >
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</section>
