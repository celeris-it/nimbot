<script lang="ts">
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
  const label = { note: "Send notes", delegate: "Delegate tasks" } as const;
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
    <h2 id="peer-access" class="card-title">
      <Icon name="delegate" size={20} />Other agents
    </h2>
    <p>
      By default {agent.name} cannot reach any other agent. A grant lets this agent
      send a note to, or delegate a task to, one other agent that has the same configured
      owner. Grants stop working immediately if either agent's owner or binding changes.
    </p>
  </div>
  <div class="panel-card">
    {#if !data}
      <p role="status">Agent access unavailable.</p>
      <ActionButton class="self-start" onclick={refresh}
        ><Icon name="refresh" size={16} />Retry loading agent access</ActionButton
      >
    {:else}
      {#if data.grants.length === 0}
        <p role="status">No grants. This agent cannot contact other agents.</p>
      {:else}
        <ul data-ui="peer-grant-list">
          {#each data.grants as item (item.targetAgentId + item.permission)}
            <li>
              {label[item.permission]} →
              <strong>{name(item.targetAgentId)}</strong>
              <ActionButton
                disabled={busy}
                aria-label={`Revoke ${label[item.permission]} to ${name(item.targetAgentId)}`}
                onclick={() => revoke(item.targetAgentId, item.permission)}
                >Revoke</ActionButton
              >
            </li>
          {/each}
        </ul>
      {/if}
      {#if data.candidates.length === 0}
        <p>
          No other agent shares this agent's owner, so there is nobody to grant.
        </p>
      {:else}
        <form onsubmit={submit} aria-describedby="form-error" aria-busy={busy}>
          <label>
            Target agent
            <Select bind:value={target} required>
              <option value="" disabled>Choose an agent</option>
              {#each data.candidates as candidate (candidate.id)}
                <option value={candidate.id}>{candidate.name}</option>
              {/each}
            </Select>
          </label>
          <label>
            Permission
            <Select bind:value={permission}>
              <option value="note">Send notes</option>
              <option value="delegate">Delegate tasks</option>
            </Select>
          </label>
          <ActionButton
            type="submit"
            variant="primary"
            disabled={busy || !target}>Add grant</ActionButton
          >
        </form>
      {/if}
    {/if}
  </div>
</section>
