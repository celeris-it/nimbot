<script lang="ts">
  import { messages } from "./i18n/language.js";
  import {
    ActionButton,
    Checkbox,
    Select,
    Switch,
    TextField,
  } from "./components/index.js";
  import { onMount, tick, untrack } from "svelte";
  import type {
    McpDiscoveryResult,
    McpExample,
  } from "../../server/src/panel/panel-contracts.js";
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
    example,
    busy,
    save,
    discoveryAgents,
    discover,
    discoverExample,
  }: {
    definition?: McpDefinition;
    example?: McpExample;
    busy: boolean;
    save: (settings: Settings) => Promise<void>;
    discoveryAgents: { id: string; name: string }[];
    discover: (agentId?: string) => Promise<McpDiscoveryResult | undefined>;
    discoverExample: (
      id: string,
      signal: AbortSignal,
    ) => Promise<McpDiscoveryResult | undefined>;
  } = $props();
  let label = $state(untrack(() => definition?.label ?? example?.label ?? ""));
  let endpoint = $state(
    untrack(() => definition?.endpoint ?? example?.endpoint ?? ""),
  );
  let enabled = $state(untrack(() => definition?.enabled ?? !!example));
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
  let parseErrorMessage = $state<() => string>();
  const parseError = $derived(parseErrorMessage?.() ?? "");
  let discovery = $state<McpDiscoveryResult>();
  let credentialAgent = $state("");
  let checkingExample = $state(false);
  let exampleConnection: AbortController | undefined;
  let endpointChanged = $derived(
    endpoint.trim() !== (definition?.endpoint ?? example?.endpoint),
  );
  const discoverAnonymously = $derived(
    !!example && !example.requiresBearerCredential,
  );
  let saveDisabled = $derived(
    busy || (discoverAnonymously && (checkingExample || tools.length === 0)),
  );
  const discoveryStatus = $derived({
    timeout: $messages("Connection timed out."),
    redirect: $messages("The endpoint attempted to redirect the connection."),
    unauthorized: $messages(
      "The endpoint rejected the connection. Check the selected credential.",
    ),
    response_too_large: $messages(
      "The MCP response exceeded Nimbot’s 256 KiB limit. If the provider offers a smaller toolset, use its endpoint.",
    ),
    unavailable: $messages("The MCP endpoint is unavailable."),
  });

  onMount(() => {
    if (!discoverAnonymously) return;
    const connection = new AbortController();
    exampleConnection = connection;
    void testExampleConnection();
    return () => connection.abort();
  });

  async function testExampleConnection() {
    if (!example || !exampleConnection || checkingExample) return;
    checkingExample = true;
    discovery = undefined;
    try {
      discovery = await discoverExample(example.id, exampleConnection.signal);
    } finally {
      checkingExample = false;
    }
  }

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
    if (saveDisabled) return;
    parseErrorMessage = undefined;
    const parsed: McpCatalogTool[] = [];
    for (const tool of tools) {
      try {
        const schema: unknown = JSON.parse(tool.schema);
        if (typeof schema !== "object" || !schema || Array.isArray(schema))
          throw new Error($messages("Expected an object schema."));
        parsed.push({
          name: tool.name,
          access: tool.access,
          inputSchema: schema as Record<string, unknown>,
        });
      } catch {
        parseErrorMessage = () =>
          $messages(
            "Enter a valid JSON schema for {0}.",
            tool.name || $messages("the unnamed tool"),
          );
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
      {$messages(
        "Some tools are disabled after a remote change. Review their schemas and access before approving them again.",
      )}
    </p>
  {/if}
  <label for="integration-label">{$messages("Integration name")}</label>
  <TextField
    id="integration-label"
    bind:value={label}
    maxlength={96}
    required
  />
  <label for="integration-endpoint">{$messages("HTTPS endpoint")}</label>
  <TextField
    id="integration-endpoint"
    type="url"
    bind:value={endpoint}
    maxlength={2048}
    readonly={!!example}
    required
    aria-describedby={discoverAnonymously ? undefined : "mcp-endpoint-help"}
  />
  {#if example?.requiresBearerCredential}
    <p id="mcp-endpoint-help">
      {$messages(
        "Save this integration, then open an agent’s Access page. Grant access and save your personal access token as the bearer credential. Return here to test the connection and review tools before enabling them for the agent.",
      )}
    </p>
  {:else if !example}
    <p id="mcp-endpoint-help">
      {$messages(
        "Use an endpoint you trust. Changing it removes current agent grants and credentials.",
      )}
    </p>
    <Switch bind:checked={enabled}>{$messages("Enable integration")}</Switch>
  {/if}
  {#if definition || discoverAnonymously}
    <h2>
      {example ? $messages("Available tools") : $messages("Connection test")}
    </h2>
  {/if}
  {#if definition}
    <label for="mcp-discovery-credential"
      >{$messages("Connection credential")}</label
    >
    <Select id="mcp-discovery-credential" bind:value={credentialAgent}>
      <option value="">{$messages("No credential")}</option>
      {#each discoveryAgents as agent (agent.id)}
        <option value={agent.id}>{agent.name} ({agent.id})</option>
      {/each}
    </Select>
    {#if endpointChanged}<p>
        {$messages("Save the endpoint before testing the connection.")}
      </p>{/if}
    <ActionButton
      type="button"
      disabled={busy || endpointChanged}
      onclick={testConnection}>{$messages("Test connection")}</ActionButton
    >
  {/if}
  {#if discoverAnonymously && checkingExample}
    <p role="status">{$messages("Finding tools…")}</p>
  {/if}
  {#if definition || discoverAnonymously}
    {#if discovery && !endpointChanged}
      {#if discovery.status === "connected"}
        <p role="status">
          {$messages("Connected.")}
          {discovery.tools.length
            ? $messages("Review the tools you want to approve.")
            : $messages("No supported tools were found.")}
        </p>
        {#if discovery.tools.length}
          <ul class="discovered">
            {#each discovery.tools as tool (tool.name)}
              <li>
                <code>{tool.name}</code>
                <ActionButton
                  type="button"
                  disabled={busy ||
                    (tools.length >= 32 &&
                      !tools.some(({ name }) => name === tool.name))}
                  onclick={() => reviewTool(tool)}
                >
                  {tools.some(({ name }) => name === tool.name)
                    ? $messages("Review schema")
                    : $messages("Review tool")}
                </ActionButton>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p role="status">
          {example && discovery.status === "unauthorized"
            ? $messages(
                "The endpoint rejected the connection without credentials.",
              )
            : discoveryStatus[discovery.status]}
        </p>
      {/if}
    {/if}
  {/if}
  {#if discoverAnonymously && discovery && (discovery.status !== "connected" || !discovery.tools.length)}
    <ActionButton
      type="button"
      disabled={checkingExample}
      onclick={testExampleConnection}
      >{$messages("Retry connection")}</ActionButton
    >
  {/if}

  <h2>{$messages("Approved tools")}</h2>
  {#if tools.length === 0}<p>{$messages("No tools selected.")}</p>{/if}
  {#each tools as tool (tool.id)}
    <fieldset class="panel-card">
      <legend>{tool.name || $messages("New tool")}</legend>
      <label for={`mcp-tool-name-${tool.id}`}>{$messages("Tool name")}</label>
      <TextField
        id={`mcp-tool-name-${tool.id}`}
        bind:value={tool.name}
        readonly={!!example}
        oninput={() => (tool.reviewed = false)}
        maxlength={128}
        required
      />
      <label for={`mcp-tool-access-${tool.id}`}>{$messages("Access")}</label>
      <Select
        id={`mcp-tool-access-${tool.id}`}
        bind:value={tool.access}
        onchange={() => (tool.reviewed = false)}
      >
        <option value="write">{$messages("Write or unknown")}</option>
        <option value="read">{$messages("Read only")}</option>
      </Select>
      <label for={`mcp-tool-schema-${tool.id}`}
        >{$messages("Argument schema (JSON)")}</label
      >
      <textarea
        class="panel-textarea"
        id={`mcp-tool-schema-${tool.id}`}
        bind:value={tool.schema}
        readonly={!!example}
        oninput={() => (tool.reviewed = false)}
        rows="6"
        maxlength={16384}
        required></textarea>
      {#if definition?.blockedTools?.includes(tool.name)}
        <p id={`mcp-tool-review-help-${tool.id}`}>
          {$messages(
            "Disabled pending review. Test the connection to retrieve the current schema, then review the schema and access above.",
          )}
        </p>
        <Checkbox
          bind:checked={tool.reviewed}
          disabled={busy}
          aria-describedby={`mcp-tool-review-help-${tool.id}`}
          >{$messages("I reviewed the schema and access for")}
          {tool.name}</Checkbox
        >
      {/if}
      <ActionButton
        type="button"
        disabled={busy}
        onclick={() => (tools = tools.filter((item) => item.id !== tool.id))}
        >{$messages("Remove tool")}</ActionButton
      >
    </fieldset>
  {/each}
  {#if parseError}<p role="alert">{parseError}</p>{/if}
  <div class="actions">
    {#if !example}
      <ActionButton
        type="button"
        disabled={busy || tools.length >= 32}
        onclick={addTool}>{$messages("Add tool")}</ActionButton
      >
    {/if}
    <ActionButton variant="primary" type="submit" disabled={saveDisabled}
      >{$messages("Save integration")}</ActionButton
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
