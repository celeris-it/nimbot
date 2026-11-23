<script lang="ts">
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
  import { Icon, PasswordField, TextField } from "./components/index.js";
  import DiscordSettings from "./DiscordSettings.svelte";
  import {
    botLabel,
    failureLabels,
    botAccessLabels,
    ownerLabels,
  } from "./labels.js";

  let {
    agent,
    busy,
    refresh,
    connectTelegram,
    discordAction,
  }: {
    agent: AgentDetail;
    busy: boolean;
    refresh: () => void;
    connectTelegram: (fields: Record<string, string>) => Promise<void>;
    discordAction: (
      kind: "save" | "remove" | "test",
      fields: Record<string, string>,
    ) => Promise<void>;
  } = $props();
  let base = $derived(`/agents/${encodeURIComponent(agent.id)}`);
  let telegramOwner = $state("");
  let telegramToken = $state("");
  async function submitTelegram(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    const fields = { ownerId: telegramOwner, token: telegramToken };
    telegramToken = "";
    await connectTelegram(fields);
  }
</script>

<h1 tabindex="-1">Channels for {agent.name}</h1>
<button class="panel-button" disabled={busy} onclick={refresh}>
  <Icon name="refresh" size={16} />Refresh channel status
</button>
<div class="settings-section-list">
  <section aria-label="Telegram connection">
    <div class="settings-section-description">
      <h2 class="card-title" data-brand="telegram">
        <Icon name="telegram" size={20} />Telegram connection
      </h2>
      {#if agent.capabilities.connectTelegram}
        <p>
          Create a separate bot in BotFather and enter its token and owner's
          numeric Telegram user ID.
        </p>
      {/if}
    </div>
    <div class="panel-card">
      {#if agent.capabilities.connectTelegram}
        <form
          onsubmit={submitTelegram}
          aria-describedby="form-error"
          aria-busy={busy}
        >
          <label for="telegram-owner">Owner's Telegram ID</label>
          <TextField
            id="telegram-owner"
            inputmode="numeric"
            pattern="[1-9][0-9]*"
            required
            bind:value={telegramOwner}
          />
          <label for="telegram-token">Telegram bot token</label>
          <PasswordField
            id="telegram-token"
            maxlength={256}
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
    </div>
  </section>

  {#if agent.discord}
    {#key agent.id}<DiscordSettings
        {agent}
        {busy}
        action={discordAction}
      />{/key}
  {/if}
</div>
