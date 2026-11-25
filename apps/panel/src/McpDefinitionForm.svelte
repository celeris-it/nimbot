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
  import { mcpDraft, parseMcpJsonc } from "./mcp-jsonc.js";
  import { tick, untrack } from "svelte";
  import type {
    McpDiscoveryResult,
    McpExample,
  } from "../../server/src/panel/panel-contracts.js";
  import type { McpDiscoveredTool } from "../../server/src/mcp/mcp-discovery.js";
  import type {
    McpDefinition,
    McpCatalogTool,
    McpDefinitionSettings,
  } from "../../server/src/mcp/mcp-catalog.js";

  type Settings = McpDefinitionSettings & { reviewedTools: string[] };
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
  let launcher = $state<"https" | "npx" | "uvx">(
    untrack(() => definition?.local?.launcher ?? "https"),
  );
  let nextInputId = 0;
  const argumentRow = (value: string) => ({ id: nextInputId++, value });
  const variableRow = (name = "", value = "") => ({
    id: nextInputId++,
    name,
    value,
  });
  let argumentsList = $state(
    untrack(() => (definition?.local?.args ?? [""]).map(argumentRow)),
  );
  let variables = $state<ReturnType<typeof variableRow>[]>([]);
  let localError = $state<"arguments" | "environment" | "emptyEnvironment">();
  let importOpen = $state(false);
  let environmentOpen = $state(
    untrack(() => definition?.credentialStatus === "saved"),
  );
  let saving = $state(false);

  async function addArgument() {
    const row = argumentRow("");
    argumentsList.push(row);
    await tick();
    document.getElementById(`mcp-argument-${row.id}`)?.focus();
  }

  async function addVariable() {
    localError = undefined;
    environmentAction = "replace";
    const row = variableRow();
    variables.push(row);
    await tick();
    document.getElementById(`mcp-variable-name-${row.id}`)?.focus();
  }

  let environmentAction = $state<"keep" | "replace" | "clear">("keep");
  let jsonc = $state("");
  let imported = $state<[string, unknown][]>([]);
  let selectedImport = $state("");
  let importError = $state<"parse" | "settings">();

  function readJsonc() {
    imported = [];
    importError = undefined;
    try {
      imported = parseMcpJsonc(jsonc);
      selectedImport = imported[0]![0];
    } catch {
      importError = "parse";
    }
  }

  async function useJsonc() {
    importError = undefined;
    try {
      const draft = mcpDraft(
        selectedImport,
        imported.find(([name]) => name === selectedImport)?.[1],
      );
      label = draft.label;
      endpoint = draft.endpoint;
      enabled = draft.enabled;
      launcher = draft.local?.launcher ?? "https";
      argumentsList = (draft.local?.args ?? [""]).map(argumentRow);
      environmentAction = draft.environment ? "replace" : "keep";
      environmentOpen = !!draft.environment;
      variables = Object.entries(draft.environment ?? {}).map(([name, value]) =>
        variableRow(name, value),
      );
      localError = undefined;
      jsonc = "";
      imported = [];
      importOpen = false;
      await tick();
      document.getElementById("integration-label")?.focus();
    } catch {
      importError = "settings";
    }
  }
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
  const environmentChanged = $derived(
    launcher !== "https" && environmentAction !== "keep",
  );
  let endpointChanged = $derived(
    launcher === "https"
      ? endpoint.trim() !== (definition?.endpoint ?? example?.endpoint)
      : launcher !== definition?.local?.launcher ||
          JSON.stringify(argumentsList.map(({ value }) => value)) !==
            JSON.stringify(definition?.local?.args),
  );
  const draftChanged = $derived(
    !!definition &&
      (label !== definition.label ||
        endpointChanged ||
        environmentChanged ||
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
    launcher_missing: $messages(
      "The MCP launcher is missing from Nimbot’s PATH.",
    ),
    startup_failed: $messages(
      "The MCP process could not start. Check the launcher arguments and package source.",
    ),
  });

  async function testConnection() {
    if (busy || endpointChanged || environmentChanged) return;
    discovery = undefined;
    discovery = await discover();
  }

  async function reviewTool(tool: McpDiscoveredTool) {
    if (busy || endpointChanged || environmentChanged) return;
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
    if (busy || saving) return;
    parseErrorMessage = undefined;
    localError = undefined;
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
    let local: McpDefinitionSettings["local"];
    let environment: McpDefinitionSettings["environment"];
    if (launcher !== "https") {
      const args = argumentsList.map(({ value }) => value);
      if (!args.some((value) => value.trim())) {
        localError = "arguments";
        await tick();
        document
          .getElementById(`mcp-argument-${argumentsList[0]?.id}`)
          ?.focus();
        return;
      }
      local = { launcher, args };
      if (environmentAction === "clear") environment = null;
      if (environmentAction === "replace") {
        if (!variables.length) {
          localError = "emptyEnvironment";
          environmentOpen = true;
          await tick();
          document.getElementById("mcp-add-variable")?.focus();
          return;
        }
        const invalid = variables.find(
          ({ name }, index) =>
            !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
            variables.findIndex((variable) => variable.name === name) !== index,
        );
        if (invalid) {
          localError = "environment";
          environmentOpen = true;
          await tick();
          document.getElementById(`mcp-variable-name-${invalid.id}`)?.focus();
          return;
        }
        environment = Object.fromEntries(
          variables.map(({ name, value }) => [name, value]),
        );
      }
    }
    saving = true;
    try {
      await save({
        label,
        endpoint: local ? "" : endpoint,
        ...(local ? { local } : {}),
        ...(environment === undefined ? {} : { environment }),
        enabled,
        tools: parsed,
        reviewedTools: tools
          .filter(
            (tool) =>
              tool.reviewed && definition?.blockedTools?.includes(tool.name),
          )
          .map((tool) => tool.name),
      });
    } finally {
      saving = false;
    }
  }
</script>

<form
  aria-busy={busy}
  onsubmit={submit}
  oninvalidcapture={(event) => {
    let disclosure = (event.target as HTMLElement).closest("details");
    while (disclosure) {
      disclosure.open = true;
      disclosure = disclosure.parentElement?.closest("details") ?? null;
    }
  }}
>
  {#if definition?.blockedTools?.length}
    <p class="panel-alert" role="alert">
      {$messages(
        "Some tools are disabled after a remote change. Review their schemas and access before approving them again.",
      )}
    </p>
  {/if}
  {#if !definition && !example}
    <details class="import-settings" bind:open={importOpen}>
      <summary>{$messages("Import MCP configuration (JSONC)")}</summary>
      <label for="mcp-jsonc">{$messages("MCP configuration")}</label>
      <textarea
        class="panel-textarea"
        id="mcp-jsonc"
        bind:value={jsonc}
        oninput={() => {
          imported = [];
          importError = undefined;
        }}
        maxlength={65536}
        spellcheck="false"
        rows="6"></textarea>
      <ActionButton
        type="button"
        disabled={busy || !jsonc.trim()}
        onclick={readJsonc}
      >
        {$messages("Read configuration")}
      </ActionButton>
      {#if imported.length}
        <label for="mcp-import-server">{$messages("Server to import")}</label>
        <Select id="mcp-import-server" bind:value={selectedImport}>
          {#each imported as [name] (name)}<option value={name}>{name}</option
            >{/each}
        </Select>
        <ActionButton type="button" disabled={busy} onclick={useJsonc}>
          {$messages("Use configuration")}
        </ActionButton>
      {/if}
      {#if importError}
        <p role="alert">
          {importError === "parse"
            ? $messages("Paste valid JSONC with at least one named MCP server.")
            : $messages(
                "This entry uses unsupported MCP settings. Check its command, working directory, environment, or authentication options.",
              )}
        </p>
      {/if}
    </details>
  {/if}
  <label for="integration-label">{$messages("Integration name")}</label>
  <TextField
    id="integration-label"
    bind:value={label}
    maxlength={96}
    required
  />
  {#if !example && (!definition || definition.local)}
    <label for="integration-launcher">{$messages("Connection type")}</label>
    <Select id="integration-launcher" bind:value={launcher}>
      {#if !definition}<option value="https">HTTPS</option>{/if}
      <option value="npx">npm (npx)</option>
      <option value="uvx">Python (uvx)</option>
    </Select>
  {/if}
  {#if launcher === "https"}
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
    {/if}
  {:else}
    <fieldset class="setup-fields">
      <legend>{$messages("Launcher arguments")}</legend>
      <p id="mcp-launcher-help">
        {$messages("Enter one argument per field in command order.")}
        <br />
        {$messages("Example")}
        <code
          >{launcher === "npx"
            ? "@modelcontextprotocol/server-everything"
            : "mcp-server-time"}</code
        >
      </p>
      {#each argumentsList as argument, index (argument.id)}
        <div class="setup-row">
          <label class="sr-only" for={`mcp-argument-${argument.id}`}
            >{$messages("Argument {0}", index + 1)}</label
          >
          <TextField
            id={`mcp-argument-${argument.id}`}
            bind:value={argument.value}
            aria-invalid={localError === "arguments" && index === 0
              ? "true"
              : undefined}
            aria-describedby={localError === "arguments" && index === 0
              ? "mcp-argument-error"
              : "mcp-launcher-help"}
            oninput={() => {
              if (localError === "arguments") localError = undefined;
            }}
            spellcheck={false}
          />
          {#if argumentsList.length > 1}
            <ActionButton
              type="button"
              aria-label={$messages("Remove argument {0}", index + 1)}
              onclick={async () => {
                argumentsList = argumentsList.filter(
                  ({ id }) => id !== argument.id,
                );
                await tick();
                document
                  .getElementById(
                    `mcp-argument-${argumentsList[Math.min(index, argumentsList.length - 1)]?.id}`,
                  )
                  ?.focus();
              }}>{$messages("Remove")}</ActionButton
            >
          {/if}
        </div>
      {/each}
      {#if localError === "arguments"}<p id="mcp-argument-error" role="alert">
          {$messages("Add at least one launcher argument.")}
        </p>{/if}
      <ActionButton
        type="button"
        disabled={argumentsList.length >= 64 || busy}
        onclick={addArgument}>{$messages("Add argument")}</ActionButton
      >
    </fieldset>
    <details class="setup-fields" bind:open={environmentOpen}>
      <summary>{$messages("Private environment variables (optional)")}</summary>
      {#if definition?.credentialStatus === "saved"}
        <label for="mcp-environment-action"
          >{$messages("Private environment variables")}</label
        >
        <Select
          id="mcp-environment-action"
          bind:value={environmentAction}
          onchange={(event) => {
            localError = undefined;
            if (event.currentTarget.value === "replace" && !variables.length)
              void addVariable();
          }}
        >
          <option value="keep">{$messages("Keep saved variables")}</option>
          <option value="replace">{$messages("Replace saved variables")}</option
          >
          <option value="clear">{$messages("Remove saved variables")}</option>
        </Select>
      {/if}
      {#if environmentAction === "replace"}
        {#each variables as variable, index (variable.id)}
          <fieldset class="variable-row">
            <div>
              <label for={`mcp-variable-name-${variable.id}`}
                >{$messages("Variable name")}</label
              >
              <TextField
                id={`mcp-variable-name-${variable.id}`}
                bind:value={variable.name}
                maxlength={128}
                spellcheck={false}
                aria-describedby={localError === "environment"
                  ? "mcp-variable-error"
                  : undefined}
                oninput={() => {
                  if (localError === "environment") localError = undefined;
                }}
              />
            </div>
            <div>
              <label for={`mcp-variable-value-${variable.id}`}
                >{$messages("Variable value")}</label
              >
              <PasswordField
                id={`mcp-variable-value-${variable.id}`}
                bind:value={variable.value}
                autocomplete="new-password"
              />
            </div>
            <ActionButton
              type="button"
              aria-label={$messages("Remove variable {0}", index + 1)}
              onclick={async () => {
                variables = variables.filter(({ id }) => id !== variable.id);
                if (
                  !variables.length &&
                  definition?.credentialStatus !== "saved"
                )
                  environmentAction = "keep";
                await tick();
                document.getElementById("mcp-add-variable")?.focus();
              }}>{$messages("Remove")}</ActionButton
            >
          </fieldset>
        {/each}
        {#if localError === "environment"}<p
            id="mcp-variable-error"
            role="alert"
          >
            {$messages(
              "Use a unique variable name with letters, numbers, and underscores. Start with a letter or underscore.",
            )}
          </p>{/if}
        {#if localError === "emptyEnvironment"}<p role="alert">
            {$messages("Add at least one variable or choose another option.")}
          </p>{/if}
      {/if}
      {#if environmentAction === "replace" || definition?.credentialStatus !== "saved"}
        <ActionButton
          id="mcp-add-variable"
          type="button"
          disabled={variables.length >= 32 || busy}
          onclick={addVariable}>{$messages("Add variable")}</ActionButton
        >
      {/if}
    </details>
  {/if}
  {#if !example}<Switch bind:checked={enabled}
      >{$messages("Enable integration")}</Switch
    >{/if}
  {#if definition}
    {#if launcher === "https"}
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
      <label for="mcp-shared-credential">{$messages("Bearer credential")}</label
      >
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
    {/if}
    <h2>{$messages("Connection test")}</h2>
    {#if definition.toolSetup === "pending"}
      <p>
        {$messages(
          "Tool setup is pending. Add a credential if required, or retry the connection.",
        )}
      </p>
    {/if}
    {#if endpointChanged || environmentChanged}<p>
        {launcher === "https"
          ? $messages("Save the endpoint before testing the connection.")
          : $messages(
              "Save the launcher settings before testing the connection.",
            )}
      </p>{/if}
    <div class="actions">
      <ActionButton
        type="button"
        disabled={busy || endpointChanged || environmentChanged}
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
  {#snippet toolEditor()}
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
          <label for={`mcp-tool-name-${tool.id}`}
            >{$messages("Tool name")}</label
          >
          <TextField
            id={`mcp-tool-name-${tool.id}`}
            bind:value={tool.name}
            readonly={!!example}
            oninput={() => (tool.reviewed = false)}
            maxlength={128}
            required
          />
          <label for={`mcp-tool-access-${tool.id}`}>{$messages("Access")}</label
          >
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
    {#if !example}
      <ActionButton type="button" disabled={busy} onclick={addTool}
        >{$messages("Add tool")}</ActionButton
      >
    {/if}
  {/snippet}
  {#if launcher !== "https" && !definition}
    <details class="setup-fields">
      <summary>{$messages("Configure tools manually (optional)")}</summary>
      {@render toolEditor()}
    </details>
  {:else}
    {@render toolEditor()}
  {/if}
  {#if parseError}<p role="alert">{parseError}</p>{/if}
  <div class="actions">
    <ActionButton variant="primary" type="submit" disabled={busy}>
      {saving ? $messages("Saving…") : $messages("Save integration")}
    </ActionButton>
  </div>
  {#if saving && !definition && launcher !== "https"}
    <p role="status">
      {$messages(
        "Saving and checking the connection. A first download can take up to 90 seconds.",
      )}
    </p>
  {/if}
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
  .setup-fields {
    min-width: 0;
  }
  .setup-fields summary,
  .import-settings summary {
    min-height: 32px;
    cursor: pointer;
    font-weight: 600;
  }
  .setup-fields > :global(:not(summary, legend)) {
    margin-block: 4px;
  }
  .setup-fields legend {
    font-size: 0.8rem;
    font-weight: 600;
  }
  .setup-fields code {
    overflow-wrap: anywhere;
  }
  .setup-row {
    display: flex;
    gap: 8px;
  }
  .variable-row > div {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  @media (min-width: 40rem) {
    .variable-row {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
      align-items: end;
    }
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
