<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AgentRule } from "../../server/src/agents/agent-rules.js";
  import { ApiError, post, request } from "./api.js";
  import { ActionButton } from "./components/index.js";
  import { messages } from "./i18n/language.js";

  let {
    agentId,
    expireSession,
  }: { agentId?: string; expireSession: () => void } = $props();
  const endpoint = $derived(
    agentId ? `/api/agents/${encodeURIComponent(agentId)}/rules` : "/api/rules",
  );
  type RuleList = { rules: AgentRule[]; sharedRules?: AgentRule[] };

  let data = $state<RuleList>();
  let busy = $state(false);
  let editing = $state<number | "new">();
  let markdown = $state("");
  let failure = $state<{
    cause: unknown;
    action: "load" | "save" | "remove";
  }>();
  let notice = $state<"saved" | "removed">();
  let heading: HTMLHeadingElement;

  function failed(cause: unknown, action: "load" | "save" | "remove") {
    if (cause instanceof ApiError && cause.status === 401) expireSession();
    else failure = { cause, action };
  }

  async function load(signal?: AbortSignal) {
    busy = true;
    failure = undefined;
    try {
      data = await request<RuleList>(endpoint, { signal });
    } catch (cause) {
      if (!signal?.aborted) failed(cause, "load");
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  });

  async function edit(rule?: AgentRule) {
    editing = rule?.id ?? "new";
    markdown = rule?.markdown ?? "";
    failure = undefined;
    notice = undefined;
    await tick();
    if (heading?.isConnected) document.getElementById("rule-markdown")?.focus();
  }

  async function closeEditor(id?: number) {
    editing = undefined;
    failure = undefined;
    await tick();
    if (!heading?.isConnected) return;
    const target =
      id === undefined ? undefined : document.getElementById(`rule-${id}-edit`);
    (target ?? heading)?.focus();
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || editing === undefined || !data) return;
    busy = true;
    failure = undefined;
    try {
      const rule = await post<AgentRule>(
        editing === "new" ? endpoint : `${endpoint}/${editing}`,
        { markdown },
      );
      data.rules =
        editing === "new"
          ? [...data.rules, rule]
          : data.rules.map((item) => (item.id === rule.id ? rule : item));
      busy = false;
      await closeEditor(rule.id);
      notice = "saved";
    } catch (cause) {
      failed(cause, "save");
    } finally {
      busy = false;
    }
  }

  function rulePreview(markdown: string) {
    const firstLine = markdown
      .trimStart()
      .split(/\r\n|[\r\n]/, 1)[0]!
      .trimEnd();
    return firstLine.length > 120
      ? `${firstLine.slice(0, 119).trimEnd()}…`
      : firstLine;
  }

  async function remove(rule: AgentRule) {
    if (
      busy ||
      !data ||
      !window.confirm(
        $messages("Remove the rule “{0}”?", rulePreview(rule.markdown)),
      )
    )
      return;
    busy = true;
    failure = undefined;
    notice = undefined;
    try {
      await post(`${endpoint}/${rule.id}/remove`, {});
      data.rules = data.rules.filter((item) => item.id !== rule.id);
      if (editing === rule.id) await closeEditor();
      else heading?.focus();
      notice = "removed";
    } catch (cause) {
      failed(cause, "remove");
    } finally {
      busy = false;
    }
  }
</script>

<h1 id="rules" tabindex="-1" bind:this={heading}>{$messages("Rules")}</h1>
<p>
  {agentId
    ? $messages(
        "These rules apply to this agent and take precedence over shared rules.",
      )
    : $messages(
        "Shared rules apply to every agent on every task. Agent rules take precedence when they conflict.",
      )}
</p>

{#if data}
  <section
    class="panel-card"
    aria-label={agentId ? $messages("Agent rules") : $messages("Shared rules")}
    aria-busy={busy}
  >
    {#if editing === undefined}
      <ActionButton variant="primary" disabled={busy} onclick={() => edit()}
        >{$messages("Add rule")}</ActionButton
      >
    {/if}
    {#if editing !== undefined}
      <form
        onsubmit={save}
        aria-label={editing === "new"
          ? $messages("Add rule")
          : $messages("Edit rule")}
      >
        <label for="rule-markdown">{$messages("Markdown")}</label>
        <textarea
          id="rule-markdown"
          class="panel-textarea"
          bind:value={markdown}
          maxlength={4000}
          rows="8"
          required
          disabled={busy}
          aria-describedby="rule-markdown-help"></textarea>
        <p id="rule-markdown-help">
          {$messages(
            "Use up to 4000 characters. Keep passwords and tokens out of rules.",
          )}
        </p>
        <div class="button-row">
          <ActionButton type="submit" variant="primary" disabled={busy}
            >{busy
              ? $messages("Saving…")
              : $messages("Save rule")}</ActionButton
          >
          <ActionButton
            disabled={busy}
            onclick={() =>
              closeEditor(typeof editing === "number" ? editing : undefined)}
            >{$messages("Cancel")}</ActionButton
          >
        </div>
      </form>
    {/if}
    {#if data.rules.length === 0}
      <p>{$messages("No rules yet.")}</p>
    {:else}
      <ul class="rule-list">
        {#each data.rules as rule (rule.id)}
          <li>
            <details>
              <summary>{rulePreview(rule.markdown)}</summary>
              <pre>{rule.markdown}</pre>
            </details>
            <div class="button-row">
              <ActionButton
                id={`rule-${rule.id}-edit`}
                disabled={busy || editing !== undefined}
                aria-label={$messages(
                  "Edit rule {0}",
                  rulePreview(rule.markdown),
                )}
                onclick={() => edit(rule)}>{$messages("Edit")}</ActionButton
              >
              <ActionButton
                disabled={busy || editing !== undefined}
                aria-label={$messages(
                  "Remove rule {0}",
                  rulePreview(rule.markdown),
                )}
                onclick={() => remove(rule)}>{$messages("Remove")}</ActionButton
              >
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
  {#if agentId}
    <section class="panel-card" aria-labelledby="inherited-rules">
      <h2 id="inherited-rules" class="card-title">
        {$messages("Shared rules")}
      </h2>
      <a href="/rules">{$messages("Manage shared rules")}</a>
      {#if data.sharedRules?.length}
        <ul class="rule-list">
          {#each data.sharedRules as rule (rule.id)}
            <li>
              <details>
                <summary>{rulePreview(rule.markdown)}</summary>
                <pre>{rule.markdown}</pre>
              </details>
            </li>
          {/each}
        </ul>
      {:else}
        <p>{$messages("No shared rules yet.")}</p>
      {/if}
    </section>
  {/if}
{:else if busy}
  <p role="status">{$messages("Loading…")}</p>
{:else if failure}
  <ActionButton onclick={() => load()}>{$messages("Retry")}</ActionButton>
{/if}

{#if failure}
  <p role="alert">
    {#if failure.cause instanceof ApiError}
      {failure.cause.display($messages)}
    {:else if failure.action === "load"}
      {$messages("Could not load rules.")}
    {:else if failure.action === "remove"}
      {$messages("Could not remove rule.")}
    {:else}
      {$messages("Could not save rule.")}
    {/if}
  </p>
{/if}
<p role="status">
  {notice === "saved"
    ? $messages("Rule saved.")
    : notice === "removed"
      ? $messages("Rule removed.")
      : ""}
</p>

<style>
  .rule-list {
    display: grid;
    gap: 1rem;
    padding: 0;
    list-style: none;
  }
  .rule-list li {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
    border-block-start: 1px solid var(--color-base-300);
    padding-block-start: 1rem;
  }
  .rule-list summary {
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rule-list pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
