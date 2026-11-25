<script lang="ts">
  import { messages } from "./i18n/language.js";
  import {
    ActionButton,
    Checkbox,
    Select,
    PasswordField,
    Switch,
    TextField,
  } from "./components/index.js";
  import { tick, untrack } from "svelte";
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
    saveCredential,
    discover,
    activate,
  }: {
    definition?: McpDefinition;
    example?: McpExample;
    busy: boolean;
    save: (settings: Settings) => Promise<void>;
    saveCredential: (token: string | null) => Promise<void>;
    discover: () => Promise<McpDiscoveryResult | undefined>;
    activate: () => Promise<void>;
  } = $props();
  let label = $state(untrack(() => definition?.label ?? example?.label ?? ""));
  let endpoint = $state(
    untrack(() => definition?.endpoint ?? example?.endpoint ?? ""),
  );
  let enabled = $state(untrack(() => definition?.enabled ?? true));
  let tools = $state(
    untrack(() =>
      (definition?.tools ?? []).map((tool, id) => ({
        id,
        name: tool.name,
        access: tool.access,
        enabled: tool.enabled !== false,
        expanded:
          (definition?.tools.length ?? 0) <= 4 ||
          !!definition?.blockedTools?.includes(tool.name),
        schema: JSON.stringify(tool.inputSchema, null, 2),
        reviewed: false,
      })),
    ),
  );
  let nextId = untrack(() => tools.length);
  let parseErrorMessage = $state<() => string>();
  const parseError = $derived(parseErrorMessage?.() ?? "");
  let discovery = $state<McpDiscoveryResult>();
  let credential = $state("");
  let endpointChanged = $derived(
    endpoint.trim() !== (definition?.endpoint ?? example?.endpoint),
  );
  const draftChanged = $derived(
    !!definition &&
      (label !== definition.label ||
        endpointChanged ||
        enabled !== definition.enabled ||
        tools.length !== definition.tools.length ||
        tools.some((tool, index) => {
          const saved = definition.tools[index];
          return (
            !saved ||
            tool.name !== saved.name ||
            tool.access !== saved.access ||
            tool.enabled !== (saved.enabled !== false) ||
            tool.schema !== JSON.stringify(saved.inputSchema, null, 2) ||
            tool.reviewed
          );
        })),
  );
  const discoveryStatus = $derived({
    timeout: $messages("Connection timed out."),
    redirect: $messages("The endpoint attempted to redirect the connection."),
    unauthorized: $messages(
      "The endpoint rejected the connection. Check the shared credential.",
    ),
    pagination_limit: $messages(
      "The MCP endpoint exceeded the four-page tool listing limit.",
    ),
    response_too_large: $messages(
      "The MCP response exceeded Nimbot’s 256 KiB limit. If the provider offers a smaller toolset, use its endpoint.",
    ),
    unavailable: $messages("The MCP endpoint is unavailable."),
  });

  async function testConnection() {
    if (busy || endpointChanged) return;
    discovery = undefined;
    discovery = await discover();
  }

  async function reviewTool(tool: McpDiscoveredTool) {
    if (busy || endpointChanged) return;
    const existing = tools.find((entry) => entry.name === tool.name);
    const schema = JSON.stringify(tool.inputSchema, null, 2);
    let id: number;
    if (existing) {
      existing.schema = schema;
      existing.reviewed = false;
      existing.expanded = true;
      id = existing.id;
    } else {
      id = nextId++;
      tools.push({
        id,
        name: tool.name,
        access: "write",
        enabled: true,
        expanded: true,
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
      enabled: true,
      expanded: true,
      schema: '{\n  "type": "object"\n}',
      reviewed: false,
    });
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
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
          ...(!tool.enabled ? { enabled: false as const } : {}),
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

<form
  aria-busy={busy}
  onsubmit={submit}
  oninvalidcapture={(event) => {
    (event.target as HTMLElement).closest("details")?.setAttribute("open", "");
  }}
>
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
    aria-describedby="mcp-endpoint-help"
  />
  {#if example?.requiresBearerCredential}
    <p id="mcp-endpoint-help">
      {$messages(
        "Save this integration, then add your personal access token on its edit page. Compatible tools are enabled when the connection succeeds.",
      )}
    </p>
  {:else if !example}
    <p id="mcp-endpoint-help">
      {$messages(
        "Use an endpoint you trust. Changing it removes the shared credential.",
      )}
    </p>
    <Switch bind:checked={enabled}>{$messages("Enable integration")}</Switch>
  {/if}
  {#if definition}
    <h2>{$messages("Shared credential")}</h2>
    <p id="mcp-credential-status">
      {definition.credentialStatus === "saved"
        ? $messages("Credential saved.")
        : definition.credentialStatus === "required"
          ? $messages("Credential required.")
          : $messages("No credential saved.")}
      {$messages(
        "Agents with this integration enabled use the same credential.",
      )}
    </p>
    <label for="mcp-shared-credential">{$messages("Bearer credential")}</label>
    <PasswordField
      id="mcp-shared-credential"
      bind:value={credential}
      maxlength={4096}
      autocomplete="new-password"
      onkeydown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (credential && !busy && !draftChanged)
          void saveCredential(credential);
      }}
      aria-describedby="mcp-credential-status"
      disabled={busy || draftChanged}
    />
    <div class="actions">
      <ActionButton
        type="button"
        disabled={busy || draftChanged || !credential}
        onclick={() => saveCredential(credential)}
        >{definition.credentialStatus === "saved"
          ? $messages("Replace credential")
          : $messages("Save credential")}</ActionButton
      >
      {#if definition.credentialStatus === "saved"}
        <ActionButton
          type="button"
          disabled={busy || draftChanged}
          onclick={() => saveCredential(null)}
          >{$messages("Remove credential")}</ActionButton
        >
      {/if}
    </div>
    {#if draftChanged}<p>
        {$messages(
          "Save your integration changes before updating the credential or tools.",
        )}
      </p>{/if}
    <h2>{$messages("Connection test")}</h2>
    {#if definition.toolSetup === "pending"}
      <p>
        {$messages(
          "Tool setup is pending. Add a credential if required, or retry the connection.",
        )}
      </p>
    {/if}
    {#if endpointChanged}<p>
        {$messages("Save the endpoint before testing the connection.")}
      </p>{/if}
    <div class="actions">
      <ActionButton
        type="button"
        disabled={busy || endpointChanged}
        onclick={testConnection}>{$messages("Test connection")}</ActionButton
      >
      <ActionButton
        type="button"
        disabled={busy || draftChanged}
        onclick={() => activate()}
        >{definition.toolSetup === "ready"
          ? $messages("Update tools")
          : definition.toolSetup === "pending"
            ? $messages("Retry tool setup")
            : $messages("Enable all tools")}</ActionButton
      >
    </div>
  {:else if !example?.requiresBearerCredential}
    <p>
      {$messages("Compatible tools are enabled when the connection succeeds.")}
    </p>
  {/if}
  {#if definition}
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
                  disabled={busy}
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
  <h2>{$messages("Approved tools")}</h2>
  {#if tools.length === 0}<p>{$messages("No tools selected.")}</p>{/if}
  {#each tools as tool (tool.id)}
    <details
      class="rounded-panel border border-base-300 bg-base-100 p-3"
      bind:open={tool.expanded}
    >
      <summary
        class="min-h-8 cursor-pointer font-semibold [overflow-wrap:anywhere]"
      >
        {tool.name || $messages("New tool")}
        {#if !tool.enabled || definition?.blockedTools?.includes(tool.name)}
          · {$messages("Disabled")}
        {/if}
      </summary>
      <fieldset aria-label={tool.name || $messages("New tool")}>
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
        {#if definition?.tools.some(({ name }) => name === tool.name)}
          <Switch bind:checked={tool.enabled} disabled={busy}
            >{$messages("Enable tool")}</Switch
          >
        {:else}
          <ActionButton
            type="button"
            disabled={busy}
            onclick={() =>
              (tools = tools.filter((item) => item.id !== tool.id))}
            >{$messages("Remove tool")}</ActionButton
          >
        {/if}
      </fieldset>
    </details>
  {/each}
  {#if parseError}<p role="alert">{parseError}</p>{/if}
  <div class="actions">
    {#if !example}
      <ActionButton type="button" disabled={busy} onclick={addTool}
        >{$messages("Add tool")}</ActionButton
      >
    {/if}
    <ActionButton variant="primary" type="submit" disabled={busy}
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
