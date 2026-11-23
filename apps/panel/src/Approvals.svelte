<script lang="ts">
  import { ActionButton, Icon, Select, TextField } from "./components/index.js";
  import type { ApprovalRequest } from "../../server/src/approvals/approval-store.js";
  import type { ApprovalRule } from "../../server/src/approvals/approval-rules.js";
  let {
    agent,
    history,
    rules,
    busy,
    createRule,
    revokeRule,
    refresh,
  }: {
    agent: { id: string; name: string };
    history: { requests: ApprovalRequest[]; hasMore: boolean } | undefined;
    rules: { rules: ApprovalRule[]; hasMore: boolean } | undefined;
    busy: boolean;
    createRule: (fields: Record<string, string>) => Promise<boolean>;
    revokeRule: (id: string) => Promise<void>;
    refresh: () => void;
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

<div data-ui="page-heading" class="flex-wrap">
  <h1 tabindex="-1">Approvals for {agent.name}</h1>
  <div class="button-row">
    {#if !rules || !history}<ActionButton disabled={busy} onclick={refresh}
        >Refresh approvals</ActionButton
      >{/if}
    <ActionButton href={`/agents/${encodeURIComponent(agent.id)}/setup`}
      >Back to agent</ActionButton
    >
  </div>
</div>
<div class="settings-section-list">
  <section aria-labelledby="approval-rules-heading">
    <div class="settings-section-description">
      <h2 id="approval-rules-heading" tabindex="-1" class="card-title">
        <Icon name="shield" size={20} />Rules
      </h2>
      <p>
        Each rule applies to one capability and one exact target. <strong
          >Deny</strong
        >
        takes precedence. <strong>Always allow</strong> requires a verified read-only
        action.
      </p>
    </div>
    <div class="panel-card">
      {#if !rules}
        <p role="status">Rules unavailable. Refresh to try again.</p>
      {:else if rules.rules.length === 0}
        <p role="status">No saved rules. Nimbot asks before write actions.</p>
      {:else}
        <ul class="rules-list">
          {#each rules.rules as rule (rule.id)}
            <li>
              <strong>{rule.effect}</strong>
              {rule.actionType} on <code>{rule.target}</code>
              {#if rule.revokedAt}· revoked {date(rule.revokedAt)}
              {:else if rule.expiresAt}· {active(rule) ? "expires" : "expired"}
                {date(rule.expiresAt)}{/if}
              {#if active(rule)}
                <ActionButton
                  disabled={busy}
                  aria-label={`Revoke rule for ${rule.actionType} on ${rule.target}`}
                  onclick={() => revokeRule(rule.id)}>Revoke</ActionButton
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <details class="border-t border-base-300 pt-3">
        <summary class="w-fit cursor-pointer py-1">Add a rule</summary>
        <form
          class="mt-3"
          onsubmit={submit}
          aria-busy={busy}
          aria-describedby="form-error"
        >
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
          <div class="grid gap-1">
            <label for="approval-rule-effect">Rule</label>
            <Select id="approval-rule-effect" bind:value={effect}>
              <option value="ask">Ask each time</option>
              <option value="deny">Deny</option>
              <option value="allow">Always allow (read-only only)</option>
            </Select>
          </div>
          <label
            >Expires after (days, optional) <TextField
              bind:value={ttlDays}
              inputmode="numeric"
              pattern="[0-9]*"
            /></label
          >
          <ActionButton type="submit" variant="primary" disabled={busy}
            >Add rule</ActionButton
          >
        </form>
      </details>
    </div>
  </section>
  <section aria-labelledby="approval-history-heading">
    <div class="settings-section-description">
      <h2 id="approval-history-heading" class="card-title">Decision history</h2>
    </div>
    <div class="panel-card">
      {#if !history}
        <p role="status">History unavailable. Refresh to try again.</p>
      {:else if history.requests.length === 0}
        <p role="status">No approval requests yet.</p>
      {:else}
        <ul class="rules-list">
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
    </div>
  </section>
</div>

<style>
  .rules-list {
    display: grid;
    gap: 8px;
    overflow-wrap: anywhere;
  }
</style>
