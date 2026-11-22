<script lang="ts">
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
  import { providers } from "../../server/src/providers/provider-contracts.js";
  import { Icon } from "./components/index.js";
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

<h1 class="sr-only" tabindex="-1">{agent.name}</h1>
<div data-ui="agent-overview">
  <div data-ui="agent-overview-grid">
    <section class="panel-card" aria-labelledby="agent-host-heading">
      <h2 id="agent-host-heading" class="card-title">
        <Icon name="server" size={20} />{agent.process
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
      <div class="button-row">
        {#if agent.process && agent.capabilities.process?.start}<button
            class="panel-button panel-button-primary"
            disabled={busy}
            onclick={() => action("start")}
            ><Icon name="play" size={16} />{busy
              ? "Starting…"
              : "Start agent"}</button
          >{/if}
        {#if agent.process && agent.capabilities.process?.stop}<a
            class="panel-button"
            href={`${base}/process/stop`}
            ><Icon name="stop" size={16} />Stop agent…</a
          >{/if}
        {#if agent.process && agent.capabilities.process?.restart}<a
            class="panel-button"
            href={`${base}/process/restart`}
            ><Icon name="restart" size={16} />Restart agent…</a
          >{/if}
        <button class="panel-button" onclick={refresh}
          ><Icon name="refresh" size={16} />Refresh status</button
        >
      </div>
    </section>
    {#if agent.providerChecks}
      <section class="panel-card" aria-labelledby="ai-provider-status">
        <h2 id="ai-provider-status" class="card-title">
          <Icon name="cpu" size={20} />AI provider status
        </h2>
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
  </div>
  <div data-ui="agent-overview-grid">
    <section class="panel-card" aria-label="Telegram connection">
      <h2 class="card-title" data-brand="telegram">
        <Icon name="telegram" size={20} />Telegram connection
      </h2>
      {#if agent.capabilities.connectTelegram}
        <p>
          Create a separate bot in BotFather and enter its token and owner's
          numeric Telegram user ID.
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
            disabled={busy}
            ><Icon name="link" size={16} />{busy
              ? "Saving…"
              : "Connect Telegram"}</button
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
            Send the bot a private message from the configured owner's account
            to link the chat.
          </p>
        {/if}
        {#if agent.capabilities.replaceToken}<div class="button-row">
            <a class="panel-button" href={`${base}/token`}
              ><Icon name="key" size={16} />Replace bot token</a
            >
          </div>{/if}
      {:else}
        <p>Telegram is unavailable.</p>
      {/if}
    </section>

    {#if agent.discord}
      {#key agent.id}<DiscordSettings
          {agent}
          {busy}
          action={discordAction}
        />{/key}
    {/if}
  </div>

  {#if agent.capabilities.delete}
    <section class="panel-card" aria-label="Danger zone" data-tone="danger">
      <h2 class="card-title">
        <Icon name="alert" size={20} />Danger zone
      </h2>
      <p>
        Deleting an agent stops its Host. Its data is kept unless you choose to
        delete it on the next page.
      </p>
      <div class="button-row">
        <a class="panel-button panel-button-danger" href={`${base}/delete`}
          ><Icon name="trash" size={16} />Delete agent…</a
        >
      </div>
    </section>
  {/if}
</div>
