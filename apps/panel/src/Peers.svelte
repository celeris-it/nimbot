<script lang="ts">
  import { messages } from "./i18n/language.js";
  import { ActionButton, Icon, Select } from "./components/index.js";
  import type { PeerGrant } from "../../server/src/peers/agent-grants.js";
  let {
    agent,
    data,
    busy,
    refresh,
    grant,
    revoke,
  }: {
    agent: { id: string; name: string };
    data:
      | { grants: PeerGrant[]; candidates: { id: string; name: string }[] }
      | undefined;
    busy: boolean;
    refresh: () => void;
    grant: (target: string, permission: string) => Promise<boolean>;
    revoke: (target: string, permission: string) => Promise<void>;
  } = $props();
  let target = $state("");
  let permission = $state("note");
  const label = $derived({
    note: $messages("Send notes"),
    delegate: $messages("Delegate tasks"),
  });
  const name = (id: string) =>
    data?.candidates.find((candidate) => candidate.id === id)?.name ?? id;
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !target) return;
    if (await grant(target, permission)) target = "";
  }
</script>

<section aria-labelledby="peer-access">
  <div class="settings-section-description">
    <h2 id="peer-access" tabindex="-1" class="card-title">
      <Icon name="delegate" size={20} />{$messages("Other agents")}
    </h2>
    <p>
      {$messages("By default")}
      {agent.name}
      {$messages(
        "cannot reach any other agent. A grant lets this agent send a note to, or delegate a task to, one other agent that has the same configured owner. Grants stop working immediately if either agent's owner or binding changes.",
      )}
    </p>
  </div>
  <div class="panel-card">
    {#if !data}
      <p role="status">{$messages("Agent access unavailable.")}</p>
      <ActionButton class="self-start" onclick={refresh}
        ><Icon name="refresh" size={16} />{$messages(
          "Retry loading agent access",
        )}</ActionButton
      >
    {:else}
      {#if data.grants.length === 0}
        <p role="status">
          {$messages("No grants. This agent cannot contact other agents.")}
        </p>
      {:else}
        <ul data-ui="peer-grant-list">
          {#each data.grants as item (item.targetAgentId + item.permission)}
            <li>
              {label[item.permission]} →
              <strong>{name(item.targetAgentId)}</strong>
              <ActionButton
                disabled={busy}
                aria-label={$messages(
                  "Revoke {0} to {1}",
                  label[item.permission],
                  name(item.targetAgentId),
                )}
                onclick={() => revoke(item.targetAgentId, item.permission)}
                >{$messages("Revoke")}</ActionButton
              >
            </li>
          {/each}
        </ul>
      {/if}
      {#if data.candidates.length === 0}
        <p>
          {$messages(
            "No other agent shares this agent's owner, so there is nobody to grant.",
          )}
        </p>
      {:else}
        <form onsubmit={submit} aria-describedby="form-error" aria-busy={busy}>
          <label>
            {$messages("Target agent")}
            <Select bind:value={target} required>
              <option value="" disabled>{$messages("Choose an agent")}</option>
              {#each data.candidates as candidate (candidate.id)}
                <option value={candidate.id}>{candidate.name}</option>
              {/each}
            </Select>
          </label>
          <label>
            {$messages("Permission")}
            <Select bind:value={permission}>
              <option value="note">{$messages("Send notes")}</option>
              <option value="delegate">{$messages("Delegate tasks")}</option>
            </Select>
          </label>
          <ActionButton
            type="submit"
            variant="primary"
            disabled={busy || !target}>{$messages("Add grant")}</ActionButton
          >
        </form>
      {/if}
    {/if}
  </div>
</section>
