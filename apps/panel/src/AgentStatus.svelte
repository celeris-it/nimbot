<script lang="ts">
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
  import { providers } from "../../server/src/providers/provider-contracts.js";
  import DiscordSettings from "./DiscordSettings.svelte";
  import {
    processLabels,
    botLabel,
    failureLabels,
    botAccessLabels,
    ownerLabels,
  } from "./labels.js";
  let {
    agent,
    busy,
    action,
    refresh,
    discordAction,
    connectTelegram,
  }: {
    agent: AgentDetail;
    busy: boolean;
    action: (kind: "start") => Promise<void>;
    refresh: () => void;
    connectTelegram: (fields: Record<string, string>) => Promise<void>;
    discordAction: (
      kind: "save" | "remove" | "test",
      fields: Record<string, string>,
    ) => Promise<void>;
  } = $props();
  let telegramOwner = $state("");
  let telegramToken = $state("");
  async function submitTelegram(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    const fields = { ownerId: telegramOwner, token: telegramToken };
    telegramToken = "";
    await connectTelegram(fields);
  }
  const providerLabels = {
    available: "Available",
    rejected: "Reconnect required",
    restricted: "Access restricted",
    rate_limited: "Rate limited",
    unavailable: "Unavailable",
    unverified: "Unverified",
    not_configured: "Not configured",
  };
  let base = $derived(`/agents/${encodeURIComponent(agent.id)}`);
  let available = $derived(
    agent.hostState
      ? agent.hostState === "ready" || agent.hostState === "busy"
      : false,
  );
  let processMessage = $derived(
    agent.process?.state === "starting"
      ? "The Agent Host is starting. Wait for the operation to finish."
      : agent.process?.state === "stopping"
        ? "The Agent Host is stopping. Wait for the operation to finish."
        : available
          ? "The Agent Host is available."
          : agent.process?.state === "running"
            ? "The process is running, but its Host API is unavailable. Refresh status or restart the agent."
            : "The agent is saved. Start the Agent Host to make it available.",
  );
</script>

<h1 tabindex="-1">{agent.name}</h1>
<section class="panel-card" aria-label="Creation result">
  <h2>
    {agent.process
      ? `Agent Host ${processLabels[agent.process.state].toLowerCase()}.`
      : "Agent Host unavailable."}
  </h2>
  <p>{processMessage}</p>
  <dl>
    {#if agent.process}
      <dt>Process</dt>
      <dd>{processLabels[agent.process.state]}</dd>
    {/if}
    {#if agent.hostState}
      <dt>Host API</dt>
      <dd>
        {{ ready: "Available", busy: "Busy", unavailable: "Offline" }[
          agent.hostState
        ]}
      </dd>
    {/if}
    {#if agent.process}
      <dt>After a Server restart</dt>
      <dd>
        {agent.process.desiredState === "running"
          ? "Restore this agent’s Host"
          : "Leave this agent stopped"}
      </dd>
    {/if}
    <dt>Identifier</dt>
    <dd>{agent.id}</dd>
  </dl>
  {#if agent.providerChecks}
    <section aria-labelledby="ai-provider-status">
      <h2 id="ai-provider-status">AI provider status</h2>
      {#if agent.providerChecks.length}
        <dl>
          {#each agent.providerChecks as check (check.id)}
            <dt>
              {providers.find((provider) => provider.id === check.id)?.name}
            </dt>
            <dd>
              {providerLabels[check.state]}
              ·
              <time datetime={new Date(check.checkedAt).toISOString()}>
                {new Date(check.checkedAt).toLocaleString()}
              </time>
            </dd>
          {/each}
        </dl>
      {:else}
        <p>
          {agent.hostState === "unavailable"
            ? "Agent Host is offline."
            : "No provider check results yet."}
        </p>
      {/if}
    </section>
  {/if}
  <div class="button-row">
    {#if agent.process && agent.capabilities.process?.start}<button
        class="panel-button panel-button-primary"
        disabled={busy}
        onclick={() => action("start")}
        >{busy ? "Starting…" : "Start agent"}</button
      >{/if}
    {#if agent.process && agent.capabilities.process?.stop}<a
        class="panel-button"
        href={`${base}/process/stop`}>Stop agent…</a
      >{/if}
    {#if agent.process && agent.capabilities.process?.restart}<a
        class="panel-button"
        href={`${base}/process/restart`}>Restart agent…</a
      >{/if}
    <button class="panel-button" onclick={refresh}>Refresh status</button>
  </div>
</section>

<section class="panel-card" aria-label="Telegram connection">
  <h2>Telegram connection</h2>
  {#if agent.capabilities.connectTelegram}
    <p>
      Create a separate bot in BotFather and enter its token and owner's numeric
      Telegram user ID.
    </p>
    <form
      onsubmit={submitTelegram}
      aria-describedby="form-error"
      aria-busy={busy}
    >
      <label for="telegram-owner">Owner's Telegram ID</label>
      <input
        class="panel-input"
        id="telegram-owner"
        inputmode="numeric"
        pattern="[1-9][0-9]*"
        required
        bind:value={telegramOwner}
      />
      <label for="telegram-token">Telegram bot token</label>
      <input
        class="panel-input"
        id="telegram-token"
        type="password"
        maxlength="256"
        autocomplete="off"
        required
        bind:value={telegramToken}
      />
      <button
        class="panel-button panel-button-primary"
        type="submit"
        disabled={busy}>{busy ? "Saving…" : "Connect Telegram"}</button
      >
    </form>
  {:else if agent.botUsername}
    <dl>
      <dt>Bot</dt>
      <dd>@{agent.botUsername}</dd>
      <dt>Connection</dt>
      <dd>{botLabel(agent)}</dd>
      {#if agent.setupAccess}
        <dt>Bot link</dt>
        <dd>{botAccessLabels[agent.setupAccess.bot]}</dd>
        <dt>Owner verification</dt>
        <dd>{ownerLabels[agent.setupAccess.owner]}</dd>
      {/if}
    </dl>
    {#if agent.botConnection?.failure}<p>
        {failureLabels[agent.botConnection.failure]}
      </p>{/if}
    {#if agent.botConnection?.status === "polling" && agent.setupAccess?.owner === "pending"}
      <p>
        Send the bot a private message from the configured owner's account to
        link the chat.
      </p>
    {/if}
    {#if agent.capabilities.replaceToken}<div class="button-row">
        <a class="panel-button" href={`${base}/token`}>Replace bot token</a>
      </div>{/if}
  {:else}
    <p>Telegram is unavailable.</p>
  {/if}
</section>

{#if agent.discord}
  {#key agent.id}<DiscordSettings {agent} {busy} action={discordAction} />{/key}
{/if}

{#if agent.capabilities.delete}
  <section class="panel-card" aria-label="Danger zone" data-tone="danger">
    <h2>Danger zone</h2>
    <p>
      Deleting an agent stops its Host. Its data is kept unless you choose to
      delete it on the next page.
    </p>
    <div class="button-row">
      <a class="panel-button panel-button-danger" href={`${base}/delete`}
        >Delete agent…</a
      >
    </div>
  </section>
{/if}
