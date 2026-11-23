<script lang="ts">
  import { messages } from "./i18n/language.js";
  import { tick, untrack } from "svelte";
  import {
    ActionButton,
    Icon,
    PasswordField,
    TextField,
  } from "./components/index.js";
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
  import type { ApiError } from "./api.js";
  import { discordConversationLabels } from "./labels.js";
  let {
    agent,
    busy,
    action,
  }: {
    agent: AgentDetail;
    busy: boolean;
    action: (
      kind: "save" | "remove" | "test",
      fields: Record<string, string>,
      handleSaveError?: (error: ApiError) => boolean,
    ) => Promise<boolean | undefined>;
  } = $props();
  let ownerId = $state(untrack(() => agent.discord?.connection?.ownerId ?? ""));
  let token = $state("");
  let tokenVisible = $state(false);
  let fieldError = $state<{ field: "owner" | "token"; error: ApiError }>();
  let requestId = $state("");
  let section: HTMLElement;
  let heading: HTMLHeadingElement;
  let wasConnected = untrack(() => !!agent.discord?.connection);
  $effect.pre(() => {
    const connected = !!agent.discord?.connection;
    if (connected === wasConnected) return;
    wasConnected = connected;
    if (
      document.activeElement === document.body ||
      section.contains(document.activeElement)
    ) {
      void tick().then(() => heading.focus());
    }
  });
  async function testDelivery(newRequest: boolean) {
    if (busy) return;
    if (newRequest || !requestId) requestId = crypto.randomUUID();
    await action("test", { requestId });
  }
  let confirmation = $state("");
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    fieldError = undefined;
    tokenVisible = false;
    const saved = await action("save", { ownerId, token }, (error) => {
      switch (error.code) {
        case "discord_owner_id_invalid":
          fieldError = { field: "owner", error };
          return true;
        case "discord_token_rejected":
          token = "";
        // Fall through to show the error next to the token field.
        case "discord_token_invalid":
        case "discord_bot_already_assigned":
          fieldError = { field: "token", error };
          return true;
        default:
          return false;
      }
    });
    tokenVisible = false;
    if (saved) token = "";
    if (fieldError) {
      const { field } = fieldError;
      await tick();
      section.querySelector<HTMLInputElement>(`#discord-${field}`)?.focus();
    }
  }
  async function remove(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    await action("remove", { confirm: confirmation });
    confirmation = "";
  }
</script>

{#snippet troubleshooting()}
  <details>
    <summary class="cursor-pointer"
      >{$messages("Trouble opening a Discord DM?")}</summary
    >
    <p class="mt-2">
      {$messages("If you still can't open a DM, open your app's")}
      <strong>Installation</strong>
      {$messages("settings, enable")}
      <strong>Guild Install</strong>{$messages(", and select")}
      <strong>Discord Provided Link</strong>{$messages(". Add the")}
      <code>bot</code>
      {$messages("scope under")} <strong>Guild Install</strong>
      {$messages(
        "and use the install link to add the bot to a private server you manage. See",
      )}
      <a
        class="underline"
        href="https://docs.discord.com/developers/quick-start/getting-started#installing-your-app"
        target="_blank"
        rel="noopener noreferrer">{$messages("Discord's installation guide")}</a
      >
      {$messages("and check that your")}
      <a
        class="underline"
        href="https://support.discord.com/hc/en-us/articles/217916488-Blocking-Privacy-Settings"
        target="_blank"
        rel="noopener noreferrer">{$messages("Discord DM settings")}</a
      >
      {$messages("allow messages from members of that server.")}
    </p>
  </details>
{/snippet}

{#snippet credentials()}
  <form onsubmit={save} aria-busy={busy} aria-describedby="form-error">
    <label for="discord-owner">{$messages("Owner's Discord user ID")}</label>
    <p id="discord-owner-help">
      {$messages(
        "Copy the user ID from your personal Discord profile. Nimbot accepts DMs from this account only.",
      )}
      <a
        class="underline"
        href="https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID"
        target="_blank"
        rel="noopener noreferrer"
        >{$messages("Discord's user ID instructions")}</a
      >.
    </p>
    <TextField
      id="discord-owner"
      name="ownerId"
      inputmode="numeric"
      pattern={"[1-9][0-9]{0,19}"}
      maxlength={20}
      required
      readonly={busy}
      bind:value={ownerId}
      aria-invalid={fieldError?.field === "owner" || undefined}
      aria-describedby={fieldError?.field === "owner"
        ? "discord-owner-error discord-owner-help"
        : "discord-owner-help"}
      oninput={() => {
        if (fieldError?.field === "owner") fieldError = undefined;
      }}
    />
    {#if fieldError?.field === "owner"}
      <p id="discord-owner-error" class="discord-field-error" role="alert">
        {fieldError.error.display($messages)}
      </p>
    {/if}
    <label for="discord-token">{$messages("Discord bot token")}</label>
    <PasswordField
      id="discord-token"
      name="token"
      autocomplete="off"
      maxlength={256}
      required
      readonly={busy}
      bind:value={token}
      bind:visible={tokenVisible}
      aria-invalid={fieldError?.field === "token" || undefined}
      aria-describedby={fieldError?.field === "token"
        ? "discord-token-error"
        : undefined}
      oninput={() => {
        if (fieldError?.field === "token") fieldError = undefined;
      }}
    />
    {#if fieldError?.field === "token"}
      <p id="discord-token-error" class="discord-field-error" role="alert">
        {fieldError.error.display($messages)}
      </p>
    {/if}
    <ActionButton variant="primary" type="submit" disabled={busy}
      ><Icon name="link" size={16} />{busy
        ? $messages("Saving…")
        : agent.discord?.connection
          ? $messages("Replace Discord connection")
          : $messages("Connect Discord")}</ActionButton
    >
  </form>
{/snippet}

<section
  bind:this={section}
  aria-label={$messages("Discord connection")}
  data-configured={!!agent.discord?.connection}
>
  <div class="settings-section-description max-w-[72ch]">
    <h2
      id="discord-connection"
      bind:this={heading}
      tabindex="-1"
      class="card-title"
      data-brand="discord"
    >
      <Icon name="discord" size={20} />{$messages("Discord connection")}
    </h2>
    {#if !agent.discord?.connection}
      <h3>{$messages("Set up a Discord bot")}</h3>
      <p>
        {$messages(
          "You'll need a bot token and your personal Discord user ID.",
        )}
      </p>
      <ol class="list-decimal space-y-2 ps-5">
        <li>
          <strong>{$messages("Create a bot and copy its token.")}</strong>
          {$messages("Open the")}
          <a
            class="underline"
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noopener noreferrer">{$messages("Discord Developer Portal")}</a
          >{$messages(", choose")} <strong>New Application</strong>{$messages(
            ", then open",
          )}
          <strong>{$messages("Bot")}</strong>
          {$messages("and select")} <strong>Reset Token</strong>{$messages(
            ". Copy the bot token and leave privileged intents off.",
          )}
        </li>
        <li>
          <strong>{$messages("Copy your Discord user ID.")}</strong>
          {$messages("Enable Developer Mode in Discord and choose")}
          <strong>Copy User ID</strong>
          {$messages("from your personal profile.")}
        </li>
        <li>
          <strong
            >{$messages("Install the app on your Discord account.")}</strong
          >
          {$messages("In your app's")} <strong>Installation</strong>
          {$messages("settings, enable")}
          <strong>User Install</strong>
          {$messages("and select")}
          <strong>Discord Provided Link</strong>{$messages(". Under")}
          <strong>Default Install Settings</strong>{$messages(", add the")}
          <code class="wrap-anywhere">applications.commands</code>
          {$messages("scope to")} <strong>User Install</strong>{$messages(
            ". Open the install link as the owner and choose",
          )} <strong>Add to my apps</strong>{$messages(
            ". This lets you open a DM without a shared server. See",
          )}
          <a
            class="underline"
            href="https://docs.discord.com/developers/quick-start/getting-started#install-to-user-account"
            target="_blank"
            rel="noopener noreferrer"
            >{$messages("Discord's account installation guide")}</a
          >.
        </li>
      </ol>
    {/if}
  </div>
  <div class="panel-card">
    {#if agent.discord?.connection}
      <dl>
        <dt>{$messages("Discord bot")}</dt>
        <dd
          data-ui="channel-identifier"
          title={agent.discord.connection.botUsername}
        >
          {agent.discord.connection.botUsername}
        </dd>
        <dt>{$messages("Discord owner")}</dt>
        <dd
          data-ui="channel-identifier"
          title={agent.discord.connection.ownerId}
        >
          {agent.discord.connection.ownerId}
        </dd>
        {#if agent.discord.conversation}
          <dt>{$messages("Discord conversation")}</dt>
          <dd>
            {$messages(
              discordConversationLabels[agent.discord.conversation.state],
            )}
          </dd>
          <dt>{$messages("Owner DM")}</dt>
          <dd>
            {agent.discord.conversation.ownerLinked
              ? $messages("Linked")
              : $messages("Waiting for a reply")}
          </dd>
        {/if}
      </dl>
      {#if agent.discord.conversation && !agent.discord.conversation.ownerLinked}
        <p>
          {$messages("Select")}
          <strong>{$messages("Send Discord test")}</strong>{$messages(
            ", then reply to the bot in Discord from the owner's account to link the DM.",
          )}
        </p>
      {/if}
      <div class="button-row">
        <ActionButton disabled={busy} onclick={() => testDelivery(true)}
          ><Icon name="send" size={16} />{$messages(
            "Send Discord test",
          )}</ActionButton
        >
        {#if requestId}
          <ActionButton disabled={busy} onclick={() => testDelivery(false)}
            ><Icon name="refresh" size={16} />{$messages(
              "Check last test status",
            )}</ActionButton
          >
        {/if}
      </div>
      {#if requestId}
        <p>
          {$messages(
            "Check the last status before sending another test if delivery is uncertain.",
          )}
        </p>
      {/if}
      {@render troubleshooting()}
      <details class="channel-settings">
        <summary>{$messages("Change Discord credentials")}</summary>
        {@render credentials()}
      </details>
      <details class="channel-settings">
        <summary>{$messages("Disconnect Discord")}</summary>
        <p>
          {$messages(
            "Disconnecting Discord keeps the agent and its files. The bot remains in Discord.",
          )}
        </p>
        <form onsubmit={remove} aria-busy={busy} aria-describedby="form-error">
          <label for="discord-confirm"
            >{$messages("Type")}
            {agent.id}
            {$messages("to confirm removal")}</label
          >
          <TextField
            id="discord-confirm"
            name="confirm"
            autocomplete="off"
            required
            bind:value={confirmation}
          />
          <ActionButton
            variant="danger"
            type="submit"
            disabled={busy || confirmation !== agent.id}
            ><Icon name="trash" size={16} />{$messages(
              "Remove Discord connection",
            )}</ActionButton
          >
        </form>
      </details>
    {:else}
      <p>{$messages("Discord is not configured.")}</p>
      {@render credentials()}
      {@render troubleshooting()}
    {/if}
  </div>
</section>

<style>
  .discord-field-error {
    color: var(--color-error);
  }
</style>
