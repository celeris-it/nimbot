<script lang="ts">
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
  import {
    ActionButton,
    Icon,
    PasswordField,
    TextField,
  } from "./components/index.js";
  import DiscordSettings from "./DiscordSettings.svelte";
  import type { ApiError } from "./api.js";
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
      handleSaveError?: (error: ApiError) => boolean,
    ) => Promise<boolean | undefined>;
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

<div data-ui="page-heading" class="flex-wrap">
  <h1 tabindex="-1">Channels for {agent.name}</h1>
  <ActionButton disabled={busy} onclick={refresh}>
    <Icon name="refresh" size={16} />Refresh channel status
  </ActionButton>
</div>
<div class="settings-section-list" data-ui="agent-channels">
  <section
    aria-label="Telegram connection"
    data-configured={!!agent.botUsername}
  >
    <div class="settings-section-description max-w-[72ch]">
      <h2
        id="telegram-connection"
        tabindex="-1"
        class="card-title"
        data-brand="telegram"
      >
        <Icon name="telegram" size={20} />Telegram connection
      </h2>
      {#if agent.capabilities.connectTelegram}
        <h3>Set up a Telegram bot</h3>
        <ol class="list-decimal space-y-2 ps-5">
          <li>
            Open
            <a
              class="underline"
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer">@BotFather</a
            >, send <code>/newbot</code>, and choose a username ending in
            <code>bot</code>. Copy the bot token.
          </li>
          <li>
            Copy your personal account's numeric Telegram user ID. You can use
            <a
              class="underline"
              href="https://t.me/userinfobot"
              target="_blank"
              rel="noopener noreferrer">@userinfobot</a
            >, a third-party bot, to find it. Paste the bot token only into
            Nimbot.
          </li>
          <li>
            Enter both values and select <strong>Connect Telegram</strong>. Open
            your new bot in Telegram and send it a private message from the
            configured owner account to link the chat.
          </li>
        </ol>
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
          <ActionButton variant="primary" type="submit" disabled={busy}
            ><Icon name="link" size={16} />{busy
              ? "Saving…"
              : "Connect Telegram"}</ActionButton
          >
        </form>
      {:else if agent.botUsername}
        <dl>
          <dt>Bot</dt>
          <dd data-ui="channel-identifier" title={`@${agent.botUsername}`}>
            @{agent.botUsername}
          </dd>
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
        <div class="button-row">
          <ActionButton href={`https://t.me/${agent.botUsername}`} icon="arrow">
            Open chat in Telegram
          </ActionButton>
          {#if agent.capabilities.replaceToken}
            <ActionButton href={`${base}/token`}
              ><Icon name="key" size={16} />Replace bot token</ActionButton
            >
          {/if}
        </div>
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
