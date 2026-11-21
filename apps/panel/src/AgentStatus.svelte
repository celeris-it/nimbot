<script lang="ts">
  import type { AgentDetail } from "../../server/src/panel-contracts.js";
  import { providers } from "../../server/src/provider-contracts.js";
  import DiscordSettings from "./DiscordSettings.svelte";
  import {
    processLabels,
    botLabel,
    failureLabels,
    botAccessLabels,
    ownerLabels,
    scheduleText,
  } from "./labels.js";
  let {
    agent,
    busy,
    mcpAvailable,
    action,
    refresh,
    discordAction,
    connectTelegram,
  }: {
    agent: AgentDetail;
    busy: boolean;
    mcpAvailable: boolean;
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
<a class="btn" href={`${base}/providers`}>Configure AI providers</a>
<a class="btn" href={`${base}/usage`}>Model and usage</a>
<a class="btn" href={`${base}/memory`}>Review memory</a>
<a class="btn" href={`${base}/approvals`}>Approvals</a>
<a class="btn" href={`${base}/peers`}>Agent access</a>
<a class="btn" href={`${base}/delegations`}>Delegations</a>
{#if mcpAvailable}<a class="btn" href={`${base}/mcp`}>MCP access</a>{/if}
<a class="btn" href={`${base}/schedules`}>{scheduleText.link}</a>
{#if agent.capabilities.edit}<a class="btn" href={`${base}/settings`}
    >Edit agent</a
  >{/if}
<section class="card" aria-label="Creation result">
  <h2>
    {agent.process
      ? `Agent Host ${processLabels[agent.process.state].toLowerCase()}.`
      : "Agent Host unavailable."}
  </h2>
  <p>{processMessage}</p>
  {#if agent.process}
    <p>Process: {processLabels[agent.process.state]}.</p>
    <p>
      After a Server restart: {agent.process.desiredState === "running"
        ? "restore this agent’s Host"
        : "leave this agent stopped"}.
    </p>
    {#if agent.capabilities.process?.start}<button
        class="btn"
        disabled={busy}
        onclick={() => action("start")}
        >{busy ? "Starting…" : "Start agent"}</button
      >{/if}
    {#if agent.capabilities.process?.stop}<a
        class="btn"
        href={`${base}/process/stop`}>Stop agent…</a
      >{/if}
    {#if agent.capabilities.process?.restart}<a
        class="btn"
        href={`${base}/process/restart`}>Restart agent…</a
      >{/if}
  {/if}
  {#if agent.hostState}<p>
      Agent Host: {{ ready: "Available", busy: "Busy", unavailable: "Offline" }[
        agent.hostState
      ]}
    </p>{/if}
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
  <dl>
    <dt>Identifier</dt>
    <dd>{agent.id}</dd>
  </dl>
  <button class="btn" onclick={refresh}>Refresh status</button>
  {#if agent.capabilities.delete}<a class="btn" href={`${base}/delete`}
      >Delete agent…</a
    >{/if}
  <a class="btn" href="/">Back to panel</a>
</section>

<section class="card" aria-label="Telegram connection">
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
        class="input"
        id="telegram-owner"
        inputmode="numeric"
        pattern="[1-9][0-9]*"
        required
        bind:value={telegramOwner}
      />
      <label for="telegram-token">Telegram bot token</label>
      <input
        class="input"
        id="telegram-token"
        type="password"
        maxlength="256"
        autocomplete="off"
        required
        bind:value={telegramToken}
      />
      <button class="btn" type="submit" disabled={busy}
        >{busy ? "Saving…" : "Connect Telegram"}</button
      >
    </form>
  {:else if agent.botUsername}
    <dl>
      <dt>Bot</dt>
      <dd>@{agent.botUsername}</dd>
      {#if agent.setupAccess}
        <dt>Bot link</dt>
        <dd>{botAccessLabels[agent.setupAccess.bot]}</dd>
        <dt>Owner verification</dt>
        <dd>{ownerLabels[agent.setupAccess.owner]}</dd>
      {/if}
    </dl>
    <p>Telegram bot: {botLabel(agent)}.</p>
    {#if agent.botConnection?.failure}<p>
        {failureLabels[agent.botConnection.failure]}
      </p>{/if}
    {#if agent.botConnection?.status === "polling" && agent.setupAccess?.owner === "pending"}
      <p>
        Send the bot a private message from the configured owner's account to
        link the chat.
      </p>
    {/if}
    {#if agent.capabilities.replaceToken}<a class="btn" href={`${base}/token`}
        >Replace bot token</a
      >{/if}
  {:else}
    <p>Telegram is unavailable.</p>
  {/if}
</section>

{#if agent.discord}
  {#key agent.id}<DiscordSettings {agent} {busy} action={discordAction} />{/key}
{/if}
