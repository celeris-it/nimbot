<script lang="ts">
  import type { PeerGrant } from "../../server/src/peers/agent-grants.js";
  let {
    agent,
    data,
    busy,
    grant,
    revoke,
  }: {
    agent: { id: string; name: string };
    data:
      | { grants: PeerGrant[]; candidates: { id: string; name: string }[] }
      | undefined;
    busy: boolean;
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

<h1 tabindex="-1">Agent access for {agent.name}</h1>
<p>
  By default {agent.name} cannot reach any other agent. A grant lets this agent send
  a note to, or delegate a task to, one other agent that has the same configured owner.
  Grants stop working immediately if either agent's owner or binding changes.
</p>
{#if !data}
  <p role="status">Agent access unavailable. Refresh to try again.</p>
{:else}
  {#if data.grants.length === 0}
    <p role="status">No grants. This agent cannot contact other agents.</p>
  {:else}
    <ul>
      {#each data.grants as item (item.targetAgentId + item.permission)}
        <li>
          {label[item.permission]} → <strong>{name(item.targetAgentId)}</strong>
          <button
            class="panel-button"
            disabled={busy}
            aria-label={`Revoke ${label[item.permission]} to ${name(item.targetAgentId)}`}
            onclick={() => revoke(item.targetAgentId, item.permission)}
            >Revoke</button
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
    <form onsubmit={submit}>
      <label>
        Target agent
        <select class="panel-select" bind:value={target} required>
          <option value="" disabled>Choose an agent</option>
          {#each data.candidates as candidate (candidate.id)}
            <option value={candidate.id}>{candidate.name}</option>
          {/each}
        </select>
      </label>
      <label>
        Permission
        <select class="panel-select" bind:value={permission}>
          <option value="note">Send notes</option>
          <option value="delegate">Delegate tasks</option>
        </select>
      </label>
      <button class="panel-button" disabled={busy || !target}>Add grant</button>
    </form>
  {/if}
{/if}
<a class="panel-button" href={`/agents/${encodeURIComponent(agent.id)}/setup`}
  >Back to agent</a
>
