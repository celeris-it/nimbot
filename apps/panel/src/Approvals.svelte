<script lang="ts">
  import { formattingLocale, messages } from "./i18n/language.js";
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
  const date = (at: number) => new Date(at).toLocaleString($formattingLocale);
  const active = (rule: ApprovalRule) =>
    !rule.revokedAt && (!rule.expiresAt || rule.expiresAt > Date.now());
  const effects = { ask: "ask", deny: "deny", allow: "allow" } as const;
  const statuses = {
    pending: "pending",
    approved: "approved",
    denied: "denied",
    expired: "expired",
    cancelled: "cancelled",
  } as const;
  const executionStatuses = {
    not_started: "not started",
    started: "started",
    completed: "completed",
    failed: "failed",
    uncertain: "uncertain",
  } as const;
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
  <h1 tabindex="-1">{$messages("Approvals for")} {agent.name}</h1>
  <div class="button-row">
    {#if !rules || !history}<ActionButton disabled={busy} onclick={refresh}
        >{$messages("Refresh approvals")}</ActionButton
      >{/if}
    <ActionButton href={`/agents/${encodeURIComponent(agent.id)}/setup`}
      >{$messages("Back to agent")}</ActionButton
    >
  </div>
</div>
<div class="settings-section-list">
  <section aria-labelledby="approval-rules-heading">
    <div class="settings-section-description">
      <h2 id="approval-rules-heading" tabindex="-1" class="card-title">
        <Icon name="shield" size={20} />{$messages("Rules")}
      </h2>
      <p>
        {$messages("Each rule applies to one capability and one exact target.")}
        <strong>{$messages("Deny")}</strong>
        {$messages("takes precedence.")}
        <strong>{$messages("Always allow")}</strong>
        {$messages("requires a verified read-only action.")}
      </p>
    </div>
    <div class="panel-card">
      {#if !rules}
        <p role="status">
          {$messages("Rules unavailable. Refresh to try again.")}
        </p>
      {:else if rules.rules.length === 0}
        <p role="status">
          {$messages("No saved rules. Nimbot asks before write actions.")}
        </p>
      {:else}
        <ul class="rules-list">
          {#each rules.rules as rule (rule.id)}
            <li>
              <strong>{$messages(effects[rule.effect])}</strong>
              {rule.actionType}
              {$messages("on")} <code>{rule.target}</code>
              {#if rule.revokedAt}{$messages("· revoked")}
                {date(rule.revokedAt)}
              {:else if rule.expiresAt}· {$messages(
                  active(rule) ? "expires" : "expired",
                )}
                {date(rule.expiresAt)}{/if}
              {#if active(rule)}
                <ActionButton
                  disabled={busy}
                  aria-label={$messages(
                    "Revoke rule for {0} on {1}",
                    rule.actionType,
                    rule.target,
                  )}
                  onclick={() => revokeRule(rule.id)}
                  >{$messages("Revoke")}</ActionButton
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <details class="border-t border-base-300 pt-3">
        <summary class="w-fit cursor-pointer py-1"
          >{$messages("Add a rule")}</summary
        >
        <form
          class="mt-3"
          onsubmit={submit}
          aria-busy={busy}
          aria-describedby="form-error"
        >
          <label
            >{$messages("Capability")}
            <TextField
              bind:value={actionType}
              required
              maxlength={64}
              placeholder="mcp.docs.write"
            /></label
          >
          <label
            >{$messages("Exact target")}
            <TextField bind:value={target} required maxlength={300} /></label
          >
          <div class="grid gap-1">
            <label for="approval-rule-effect">{$messages("Rule")}</label>
            <Select id="approval-rule-effect" bind:value={effect}>
              <option value="ask">{$messages("Ask each time")}</option>
              <option value="deny">{$messages("Deny")}</option>
              <option value="allow"
                >{$messages("Always allow (read-only only)")}</option
              >
            </Select>
          </div>
          <label
            >{$messages("Expires after (days, optional)")}
            <TextField
              bind:value={ttlDays}
              inputmode="numeric"
              pattern="[0-9]*"
            /></label
          >
          <ActionButton type="submit" variant="primary" disabled={busy}
            >{$messages("Add rule")}</ActionButton
          >
        </form>
      </details>
    </div>
  </section>
  <section aria-labelledby="approval-history-heading">
    <div class="settings-section-description">
      <h2 id="approval-history-heading" class="card-title">
        {$messages("Decision history")}
      </h2>
    </div>
    <div class="panel-card">
      {#if !history}
        <p role="status">
          {$messages("History unavailable. Refresh to try again.")}
        </p>
      {:else if history.requests.length === 0}
        <p role="status">{$messages("No approval requests yet.")}</p>
      {:else}
        <ul class="rules-list">
          {#each history.requests as request (request.id)}
            <li>
              <strong>{$messages(statuses[request.status])}</strong>
              {request.actionType}
              {$messages("on")} <code>{request.target}</code> — {request.summary}
              <br />
              {$messages("Requested")}
              {date(request.createdAt)}{#if request.decidedBy}
                {$messages("· decided by")} {request.decidedBy}{/if}
              {#if request.status === "approved"}{$messages("· execution:")}
                {$messages(executionStatuses[request.execution])}{/if}
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
