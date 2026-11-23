<script lang="ts">
  import { Checkbox, Select, Switch, TextField } from "./components/index.js";
  import { tick, untrack } from "svelte";
  import type { McpDiscoveryResult } from "../../server/src/panel/panel-contracts.js";
  import type { McpDiscoveredTool } from "../../server/src/mcp/mcp-discovery.js";
  import type {
    McpDefinition,
    McpCatalogTool,
  } from "../../server/src/mcp/mcp-catalog.js";

  type Settings = Pick<
    McpDefinition,
    "label" | "endpoint" | "enabled" | "tools"
  > & { reviewedTools: string[] };
  let {
    definition,
    busy,
    save,
    discoveryAgents,
    discover,
  }: {
    definition?: McpDefinition;
    busy: boolean;
    save: (settings: Settings) => Promise<void>;
    discoveryAgents: { id: string; name: string }[];
    discover: (agentId?: string) => Promise<McpDiscoveryResult | undefined>;
  } = $props();
  let label = $state(untrack(() => definition?.label ?? ""));
  let endpoint = $state(untrack(() => definition?.endpoint ?? ""));
  let enabled = $state(untrack(() => definition?.enabled ?? false));
  let tools = $state(
    untrack(() =>
      (definition?.tools ?? []).map((tool, id) => ({
        id,
        name: tool.name,
        access: tool.access,
        schema: JSON.stringify(tool.inputSchema, null, 2),
        reviewed: false,
      })),
    ),
  );
  let nextId = untrack(() => tools.length);
  let parseError = $state("");
  let discovery = $state<McpDiscoveryResult>();
  let credentialAgent = $state("");
  let endpointChanged = $derived(endpoint.trim() !== definition?.endpoint);
  const discoveryStatus = {
    timeout: "Connection timed out.",
    redirect: "The endpoint attempted to redirect the connection.",
    unauthorized:
      "The endpoint rejected the connection. Check the selected credential.",
    unavailable: "The MCP endpoint is unavailable.",
  };

  async function testConnection() {
    if (busy || endpointChanged) return;
    discovery = undefined;
    discovery = await discover(credentialAgent || undefined);
  }

  async function reviewTool(tool: McpDiscoveredTool) {
    if (busy || endpointChanged) return;
    const existing = tools.find((entry) => entry.name === tool.name);
    const schema = JSON.stringify(tool.inputSchema, null, 2);
    let id: number;
    if (existing) {
      existing.schema = schema;
      existing.reviewed = false;
      id = existing.id;
    } else {
      if (tools.length >= 32) return;
      id = nextId++;
      tools.push({
        id,
        name: tool.name,
        access: "write",
        schema,
        reviewed: false,
      });
    }
    await tick();
    document.getElementById(`mcp-tool-schema-${id}`)?.focus();
  }

  function addTool() {
    tools.push({
      id: nextId++,
      name: "",
      access: "write",
      schema: '{\n  "type": "object"\n}',
      reviewed: false,
    });
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    parseError = "";
    const parsed: McpCatalogTool[] = [];
    for (const tool of tools) {
      try {
        const schema: unknown = JSON.parse(tool.schema);
        if (typeof schema !== "object" || !schema || Array.isArray(schema))
          throw new Error("Expected an object schema.");
        parsed.push({
          name: tool.name,
          access: tool.access,
          inputSchema: schema as Record<string, unknown>,
        });
      } catch {
        parseError = `Enter a valid JSON schema for ${tool.name || "the unnamed tool"}.`;
        return;
      }
    }
    await save({
      label,
      endpoint,
      enabled,
      tools: parsed,
      reviewedTools: tools
        .filter(
          (tool) =>
            tool.reviewed && definition?.blockedTools?.includes(tool.name),
        )
        .map((tool) => tool.name),
    });
  }
</script>

<form aria-busy={busy} onsubmit={submit}>
  {#if definition?.blockedTools?.length}
    <p class="panel-alert" role="alert">
      Some tools are disabled after a remote change. Review their schemas and
      access before approving them again.
    </p>
  {/if}
  <label for="integration-label">Integration name</label>
  <TextField
    id="integration-label"
    bind:value={label}
    maxlength={96}
    required
  />
  <label for="integration-endpoint">HTTPS endpoint</label>
  <TextField
    id="integration-endpoint"
    type="url"
    bind:value={endpoint}
    maxlength={2048}
    required
    aria-describedby="mcp-endpoint-help"
  />
  <p id="mcp-endpoint-help">
    Use an endpoint you trust. Changing it removes current agent grants and
    credentials.
  </p>
  <Switch bind:checked={enabled}>Enable integration</Switch>

  {#if definition}
    <h2>Connection test</h2>
    <label for="mcp-discovery-credential">Connection credential</label>
    <Select id="mcp-discovery-credential" bind:value={credentialAgent}>
      <option value="">No credential</option>
      {#each discoveryAgents as agent (agent.id)}
        <option value={agent.id}>{agent.name} ({agent.id})</option>
      {/each}
    </Select>
    {#if endpointChanged}<p>
        Save the endpoint before testing the connection.
      </p>{/if}
    <button
      class="panel-button"
      type="button"
      disabled={busy || endpointChanged}
      onclick={testConnection}>Test connection</button
    >
    {#if discovery && !endpointChanged}
      {#if discovery.status === "connected"}
        <p role="status">
          Connected. {discovery.tools.length
            ? "Review the tools you want to approve."
            : "No supported tools were found."}
        </p>
        {#if discovery.tools.length}
          <ul class="discovered">
            {#each discovery.tools as tool (tool.name)}
              <li>
                <code>{tool.name}</code>
                <button
                  class="panel-button"
                  type="button"
                  disabled={busy ||
                    (tools.length >= 32 &&
                      !tools.some(({ name }) => name === tool.name))}
                  onclick={() => reviewTool(tool)}
                >
                  {tools.some(({ name }) => name === tool.name)
                    ? "Review schema"
                    : "Review tool"}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p role="status">{discoveryStatus[discovery.status]}</p>
      {/if}
    {/if}
  {/if}

  <h2>Approved tools</h2>
  {#if tools.length === 0}<p>No tools selected.</p>{/if}
  {#each tools as tool (tool.id)}
    <fieldset class="panel-card">
      <legend>{tool.name || "New tool"}</legend>
      <label for={`mcp-tool-name-${tool.id}`}>Tool name</label>
      <TextField
        id={`mcp-tool-name-${tool.id}`}
        bind:value={tool.name}
        oninput={() => (tool.reviewed = false)}
        maxlength={128}
        required
      />
      <label for={`mcp-tool-access-${tool.id}`}>Access</label>
      <Select
        id={`mcp-tool-access-${tool.id}`}
        bind:value={tool.access}
        onchange={() => (tool.reviewed = false)}
      >
        <option value="write">Write or unknown</option>
        <option value="read">Read only</option>
      </Select>
      <label for={`mcp-tool-schema-${tool.id}`}>Argument schema (JSON)</label>
      <textarea
        class="panel-textarea"
        id={`mcp-tool-schema-${tool.id}`}
        bind:value={tool.schema}
        oninput={() => (tool.reviewed = false)}
        rows="6"
        maxlength={16384}
        required></textarea>
      {#if definition?.blockedTools?.includes(tool.name)}
        <p id={`mcp-tool-review-help-${tool.id}`}>
          Disabled pending review. Test the connection to retrieve the current
          schema, then review the schema and access above.
        </p>
        <Checkbox
          bind:checked={tool.reviewed}
          disabled={busy}
          aria-describedby={`mcp-tool-review-help-${tool.id}`}
          >I reviewed the schema and access for {tool.name}</Checkbox
        >
      {/if}
      <button
        class="panel-button"
        type="button"
        disabled={busy}
        onclick={() => (tools = tools.filter((item) => item.id !== tool.id))}
        >Remove tool</button
      >
    </fieldset>
  {/each}
  {#if parseError}<p role="alert">{parseError}</p>{/if}
  <div class="actions">
    <button
      class="panel-button"
      type="button"
      disabled={busy || tools.length >= 32}
      onclick={addTool}>Add tool</button
    >
    <button
      class="panel-button panel-button-primary"
      type="submit"
      disabled={busy}>Save integration</button
    >
  </div>
</form>

<style>
  fieldset {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  textarea {
    font-family: monospace;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .discovered {
    padding: 0;
    list-style: none;
  }
  .discovered li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    overflow-wrap: anywhere;
  }
</style>
