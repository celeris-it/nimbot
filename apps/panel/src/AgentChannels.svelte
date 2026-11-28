<script lang="ts">
  import { messages } from "./i18n/language.js";
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
    syncAvatar,
  }: {
    agent: AgentDetail;
    busy: boolean;
    refresh: () => void;
    syncAvatar: () => Promise<void>;
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
  <h1 tabindex="-1">{$messages("Channels for")} {agent.name}</h1>
  <div class="button-row">
    <ActionButton disabled={busy} onclick={syncAvatar}>
      <Icon name="refresh" size={16} />{$messages("Update bot avatars")}
    </ActionButton>
    <ActionButton disabled={busy} onclick={refresh}>
      <Icon name="refresh" size={16} />{$messages("Refresh channel status")}
    </ActionButton>
  </div>
</div>
<div class="settings-section-list" data-ui="agent-channels">
  <section
    aria-label={$messages("Telegram connection")}
    data-configured={!!agent.botUsername}
  >
    <div class="settings-section-description max-w-[72ch]">
      <h2
        id="telegram-connection"
        tabindex="-1"
        class="card-title"
        data-brand="telegram"
      >
        <Icon name="telegram" size={20} />{$messages("Telegram connection")}
      </h2>
      {#if agent.capabilities.connectTelegram}
        <h3>{$messages("Set up a Telegram bot")}</h3>
        <ol class="list-decimal space-y-2 ps-5">
          <li>
            {$messages("Open")}
            <a
              class="underline"
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer">@BotFather</a
            >{$messages(", send")} <code>/newbot</code>{$messages(
              ", and choose a username ending in",
            )}
            <code>bot</code>{$messages(". Copy the bot token.")}
          </li>
          <li>
            {$messages(
              "Copy your personal account's numeric Telegram user ID. You can use",
            )}
            <a
              class="underline"
              href="https://t.me/userinfobot"
              target="_blank"
              rel="noopener noreferrer">@userinfobot</a
            >{$messages(
              ", a third-party bot, to find it. Paste the bot token only into Nimbot.",
            )}
          </li>
          <li>
            {$messages("Enter both values and select")}
            <strong>{$messages("Connect Telegram")}</strong>{$messages(
              ". Open your new bot in Telegram and send it a private message from the configured owner account to link the chat.",
            )}
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
          <label for="telegram-owner">{$messages("Owner's Telegram ID")}</label>
          <TextField
            id="telegram-owner"
            inputmode="numeric"
            pattern="[1-9][0-9]*"
            required
            bind:value={telegramOwner}
          />
          <label for="telegram-token">{$messages("Telegram bot token")}</label>
          <PasswordField
            id="telegram-token"
            maxlength={256}
            autocomplete="off"
            required
            bind:value={telegramToken}
          />
          <ActionButton variant="primary" type="submit" disabled={busy}
            ><Icon name="link" size={16} />{busy
              ? $messages("Saving…")
              : $messages("Connect Telegram")}</ActionButton
          >
        </form>
      {:else if agent.botUsername}
        <dl>
          <dt>{$messages("Bot")}</dt>
          <dd data-ui="channel-identifier" title={`@${agent.botUsername}`}>
            @{agent.botUsername}
          </dd>
          <dt>{$messages("Connection")}</dt>
          <dd>{botLabel($messages, agent)}</dd>
          {#if agent.setupAccess}
            <dt>{$messages("Bot link")}</dt>
            <dd>{$messages(botAccessLabels[agent.setupAccess.bot])}</dd>
            <dt>{$messages("Owner verification")}</dt>
            <dd>{$messages(ownerLabels[agent.setupAccess.owner])}</dd>
          {/if}
        </dl>
        {#if agent.botConnection?.failure}<p>
            {$messages(failureLabels[agent.botConnection.failure])}
          </p>{/if}
        {#if agent.botConnection?.status === "polling" && agent.setupAccess?.owner === "pending"}
          <p>
            {$messages(
              "Send the bot a private message from the configured owner's account to link the chat.",
            )}
          </p>
        {/if}
        <div class="button-row">
          <ActionButton href={`https://t.me/${agent.botUsername}`} icon="arrow">
            {$messages("Open chat in Telegram")}
          </ActionButton>
          {#if agent.capabilities.replaceToken}
            <ActionButton href={`${base}/token`}
              ><Icon name="key" size={16} />{$messages(
                "Replace bot token",
              )}</ActionButton
            >
          {/if}
        </div>
      {:else}
        <p>{$messages("Telegram is unavailable.")}</p>
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
