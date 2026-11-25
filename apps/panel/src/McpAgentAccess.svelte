<script lang="ts">
  import { messages, numberFormat, pluralRules } from "./i18n/language.js";
  import { ActionButton, Icon, Switch } from "./components/index.js";
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
    action: (definition: McpAgentDefinition, enabled: boolean) => Promise<void>;
  } = $props();
</script>

<section aria-labelledby="mcp-access">
  <div class="settings-section-description">
    <h2 id="mcp-access" tabindex="-1" class="card-title">
      <Icon name="plug" size={20} />{$messages("MCP integrations")}
    </h2>
  </div>
  <div class="panel-card">
    <ActionButton class="self-start" href="/mcp"
      >{$messages("MCP catalog")}</ActionButton
    >
    {#if !definitions}
      <p role="status">{$messages("MCP integrations unavailable.")}</p>
      <ActionButton class="self-start" onclick={refresh}
        ><Icon name="refresh" size={16} />{$messages(
          "Retry loading MCP integrations",
        )}</ActionButton
      >
    {:else if definitions.length === 0}
      <p>{$messages("No integrations in the catalog.")}</p>
    {:else}
      {#each definitions as definition (definition.id)}
        <section
          data-ui="agent-mcp-integration"
          aria-labelledby={`integration-${definition.id}`}
        >
          <h3 id={`integration-${definition.id}`}>{definition.label}</h3>
          <Switch
            checked={definition.accessEnabled}
            disabled={busy}
            onchange={(event) => {
              // Render the confirmed setting until the Server saves the change.
              const enabled = event.currentTarget.checked;
              event.currentTarget.checked = definition.accessEnabled;
              void action(definition, enabled);
            }}
            >{$messages("Enable {0} for this agent", definition.label)}</Switch
          >
          {#if !definition.enabled}
            <p>{$messages("Disabled in catalog")}</p>
          {/if}
          {#if definition.credentialStatus === "required"}
            <p>
              {$messages("Credential required.")}
              <a href={`/mcp/${encodeURIComponent(definition.id)}`}
                >{$messages("Set shared credential")}</a
              >
            </p>
          {/if}
          {#if definition.blockedTools?.length}
            <p>
              {$messages(
                $pluralRules.select(definition.blockedTools.length) === "one"
                  ? "{0} tool disabled pending review."
                  : "{0} tools disabled pending review.",
                $numberFormat.format(definition.blockedTools.length),
              )}
              <a href={`/mcp/${encodeURIComponent(definition.id)}`}
                >{$messages("Review tools")}</a
              >
            </p>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</section>
