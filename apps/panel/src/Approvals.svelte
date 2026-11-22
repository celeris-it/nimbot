<script lang="ts">
  import { Select, TextField } from "./components/index.js";
  import type { ApprovalRequest } from "../../server/src/approvals/approval-store.js";
  import type { ApprovalRule } from "../../server/src/approvals/approval-rules.js";
  let {
    agent,
    history,
    rules,
    busy,
    createRule,
    revokeRule,
  }: {
    agent: { id: string; name: string };
    history: { requests: ApprovalRequest[]; hasMore: boolean } | undefined;
    rules: { rules: ApprovalRule[]; hasMore: boolean } | undefined;
    busy: boolean;
    createRule: (fields: Record<string, string>) => Promise<boolean>;
    revokeRule: (id: string) => Promise<void>;
  } = $props();
  let actionType = $state("");
  let target = $state("");
  let effect = $state("ask");
  let ttlDays = $state("");
  const date = (at: number) => new Date(at).toLocaleString();
  const active = (rule: ApprovalRule) =>
    !rule.revokedAt && (!rule.expiresAt || rule.expiresAt > Date.now());
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (await createRule({ actionType, target, effect, ttlDays })) {
      actionType = "";
      target = "";
      ttlDays = "";
    }
  }
</script>

<h1 tabindex="-1">Approvals for {agent.name}</h1>
<p>
  Rules apply to one capability and one exact target of this agent. By default
  every write asks each time. An explicit <strong>Deny</strong> always wins.
  <strong>Always allow</strong> is only accepted for actions Nimbot itself can verify
  as read-only.
</p>

<h2>Rules</h2>
{#if !rules}
  <p role="status">Rules unavailable. Refresh to try again.</p>
{:else if rules.rules.length === 0}
  <p role="status">No rules. Every action asks each time.</p>
{:else}
  <ul>
    {#each rules.rules as rule (rule.id)}
      <li>
        <strong>{rule.effect}</strong>
        {rule.actionType} on <code>{rule.target}</code>
        {#if rule.revokedAt}· revoked {date(rule.revokedAt)}
        {:else if rule.expiresAt}· {active(rule) ? "expires" : "expired"}
          {date(rule.expiresAt)}{/if}
        {#if active(rule)}
          <button
            class="panel-button"
            disabled={busy}
            aria-label={`Revoke rule for ${rule.actionType} on ${rule.target}`}
            onclick={() => revokeRule(rule.id)}>Revoke</button
          >
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<form onsubmit={submit}>
  <label
    >Capability <TextField
      bind:value={actionType}
      required
      maxlength={64}
      placeholder="mcp.docs.write"
    /></label
  >
  <label
    >Exact target <TextField
      bind:value={target}
      required
      maxlength={300}
    /></label
  >
  <label>
    Rule
    <Select bind:value={effect}>
      <option value="ask">Ask each time</option>
      <option value="deny">Deny</option>
      <option value="allow">Always allow (read-only only)</option>
    </Select>
  </label>
  <label
    >Expires after (days, optional) <TextField
      bind:value={ttlDays}
      inputmode="numeric"
      pattern="[0-9]*"
    /></label
  >
  <button class="panel-button panel-button-primary" disabled={busy}
    >Add rule</button
  >
</form>

<h2>Decision history</h2>
{#if !history}
  <p role="status">History unavailable. Refresh to try again.</p>
{:else if history.requests.length === 0}
  <p role="status">No approval requests yet.</p>
{:else}
  <ul>
    {#each history.requests as request (request.id)}
      <li>
        <strong>{request.status}</strong>
        {request.actionType} on <code>{request.target}</code> — {request.summary}
        <br />
        Requested {date(request.createdAt)}{#if request.decidedBy}
          · decided by {request.decidedBy}{/if}
        {#if request.status === "approved"}· execution: {request.execution.replace(
            "_",
            " ",
          )}{/if}
      </li>
    {/each}
  </ul>
{/if}
<a class="panel-button" href={`/agents/${encodeURIComponent(agent.id)}/setup`}
  >Back to agent</a
>
