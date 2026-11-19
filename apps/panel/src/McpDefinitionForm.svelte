<script lang="ts">
  import { untrack } from "svelte";
  import type {
    McpDefinition,
    McpCatalogTool,
  } from "../../server/src/mcp-catalog.js";

  type Settings = Pick<
    McpDefinition,
    "label" | "endpoint" | "enabled" | "tools"
  >;
  let {
    definition,
    busy,
    save,
  }: {
    definition?: McpDefinition;
    busy: boolean;
    save: (settings: Settings) => Promise<void>;
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
      })),
    ),
  );
  let nextId = untrack(() => tools.length);
  let parseError = $state("");

  function addTool() {
    tools.push({
      id: nextId++,
      name: "",
      access: "write",
      schema: '{\n  "type": "object"\n}',
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
    await save({ label, endpoint, enabled, tools: parsed });
  }
</script>

<form aria-busy={busy} onsubmit={submit}>
  <label for="integration-label">Integration name</label>
  <input
    class="input"
    id="integration-label"
    bind:value={label}
    maxlength="96"
    required
  />
  <label for="integration-endpoint">HTTPS endpoint</label>
  <input
    class="input"
    id="integration-endpoint"
    type="url"
    bind:value={endpoint}
    maxlength="2048"
    required
    aria-describedby="mcp-endpoint-help"
  />
  <p id="mcp-endpoint-help">
    Use an endpoint you trust. Changing it removes current agent grants and
    credentials.
  </p>
  <label
    ><input class="checkbox" type="checkbox" bind:checked={enabled} /> Enable integration</label
  >

  <h2>Approved tools</h2>
  {#if tools.length === 0}<p>No tools selected.</p>{/if}
  {#each tools as tool (tool.id)}
    <fieldset class="card">
      <legend>{tool.name || "New tool"}</legend>
      <label for={`mcp-tool-name-${tool.id}`}>Tool name</label>
      <input
        class="input"
        id={`mcp-tool-name-${tool.id}`}
        bind:value={tool.name}
        maxlength="128"
        required
      />
      <label for={`mcp-tool-access-${tool.id}`}>Access</label>
      <select id={`mcp-tool-access-${tool.id}`} bind:value={tool.access}>
        <option value="write">Write or unknown</option>
        <option value="read">Read only</option>
      </select>
      <label for={`mcp-tool-schema-${tool.id}`}>Argument schema (JSON)</label>
      <textarea
        class="textarea"
        id={`mcp-tool-schema-${tool.id}`}
        bind:value={tool.schema}
        rows="6"
        maxlength="16384"
        required></textarea>
      <button
        class="btn"
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
      class="btn"
      type="button"
      disabled={busy || tools.length >= 32}
      onclick={addTool}>Add tool</button
    >
    <button class="btn btn-primary" type="submit" disabled={busy}
      >Save integration</button
    >
  </div>
</form>

<style>
  fieldset {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }
  textarea {
    font-family: monospace;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
