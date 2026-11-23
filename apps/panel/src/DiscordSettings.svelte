<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    ActionButton,
    Icon,
    PasswordField,
    TextField,
  } from "./components/index.js";
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
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
    ) => Promise<void>;
  } = $props();
  let ownerId = $state(untrack(() => agent.discord?.connection?.ownerId ?? ""));
  let token = $state("");
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
    const submitted = token;
    token = "";
    await action("save", { ownerId, token: submitted });
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
    <summary class="cursor-pointer">Trouble opening a Discord DM?</summary>
    <p class="mt-2">
      If you still can't open a DM, open your app's
      <strong>Installation</strong> settings, enable
      <strong>Guild Install</strong>, and select
      <strong>Discord Provided Link</strong>. Add the <code>bot</code> scope
      under <strong>Guild Install</strong> and use the install link to add the
      bot to a private server you manage. See
      <a
        class="underline"
        href="https://docs.discord.com/developers/quick-start/getting-started#installing-your-app"
        target="_blank"
        rel="noopener noreferrer">Discord's installation guide</a
      >
      and check that your
      <a
        class="underline"
        href="https://support.discord.com/hc/en-us/articles/217916488-Blocking-Privacy-Settings"
        target="_blank"
        rel="noopener noreferrer">Discord DM settings</a
      >
      allow messages from members of that server.
    </p>
  </details>
{/snippet}

{#snippet credentials()}
  <form onsubmit={save} aria-busy={busy} aria-describedby="form-error">
    <label for="discord-owner">Owner's Discord user ID</label>
    <TextField
      id="discord-owner"
      name="ownerId"
      inputmode="numeric"
      pattern={"[1-9][0-9]{0,19}"}
      maxlength={20}
      required
      bind:value={ownerId}
      aria-describedby="discord-owner-help"
    />
    <p id="discord-owner-help">Nimbot accepts DMs from this account only.</p>
    <label for="discord-token">Discord bot token</label>
    <PasswordField
      id="discord-token"
      name="token"
      autocomplete="off"
      maxlength={256}
      required
      bind:value={token}
      aria-describedby="discord-token-help"
    />
    <p id="discord-token-help">
      The token is stored privately. Enter it again if saving fails.
    </p>
    <ActionButton variant="primary" type="submit" disabled={busy}
      ><Icon name="link" size={16} />{busy
        ? "Saving…"
        : agent.discord?.connection
          ? "Replace Discord connection"
          : "Connect Discord"}</ActionButton
    >
  </form>
{/snippet}

<section
  bind:this={section}
  aria-label="Discord connection"
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
      <Icon name="discord" size={20} />Discord connection
    </h2>
    {#if !agent.discord?.connection}
      <h3>Set up a Discord bot</h3>
      <ol class="list-decimal space-y-2 ps-5">
        <li>
          Open the
          <a
            class="underline"
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noopener noreferrer">Discord Developer Portal</a
          >, choose <strong>New Application</strong>, then open
          <strong>Bot</strong>
          and select <strong>Reset Token</strong>. Copy the bot token and leave
          privileged intents off.
        </li>
        <li>
          Enable Developer Mode in Discord and copy your personal account's user
          ID. See
          <a
            class="underline"
            href="https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID"
            target="_blank"
            rel="noopener noreferrer">Discord's user ID instructions</a
          >.
        </li>
        <li>
          To open a DM without a shared server, open your app's
          <strong>Installation</strong> settings. Enable
          <strong>User Install</strong>, add the
          <code>applications.commands</code>
          scope under <strong>User Install</strong>, and select
          <strong>Discord Provided Link</strong>. Open the link with the owner
          account and select <strong>Add to my apps</strong>. See
          <a
            class="underline"
            href="https://docs.discord.com/developers/quick-start/getting-started#install-to-user-account"
            target="_blank"
            rel="noopener noreferrer">Discord's account installation guide</a
          >.
        </li>
        <li>
          Enter the token and owner ID and select <strong
            >Connect Discord</strong
          >. Once the app is installed and connected, use
          <strong>Send Discord test</strong>
          to check delivery. Reply to the bot in the private chat to link it to Nimbot.
        </li>
      </ol>
    {/if}
    {#if !agent.discord?.connection}{@render troubleshooting()}{/if}
  </div>
  <div class="panel-card">
    {#if agent.discord?.connection}
      <dl>
        <dt>Discord bot</dt>
        <dd
          data-ui="channel-identifier"
          title={agent.discord.connection.botUsername}
        >
          {agent.discord.connection.botUsername}
        </dd>
        <dt>Discord owner</dt>
        <dd
          data-ui="channel-identifier"
          title={agent.discord.connection.ownerId}
        >
          {agent.discord.connection.ownerId}
        </dd>
        {#if agent.discord.conversation}
          <dt>Discord conversation</dt>
          <dd>{discordConversationLabels[agent.discord.conversation.state]}</dd>
          <dt>Owner DM</dt>
          <dd>
            {agent.discord.conversation.ownerLinked
              ? "Linked"
              : "Waiting for a reply"}
          </dd>
        {/if}
      </dl>
      {#if agent.discord.conversation && !agent.discord.conversation.ownerLinked}
        <p>
          Send a Discord test, then reply from the owner's account to link the
          DM.
        </p>
      {/if}
      <div class="button-row">
        <ActionButton disabled={busy} onclick={() => testDelivery(true)}
          ><Icon name="send" size={16} />Send Discord test</ActionButton
        >
        {#if requestId}
          <ActionButton disabled={busy} onclick={() => testDelivery(false)}
            ><Icon name="refresh" size={16} />Check last test status</ActionButton
          >
        {/if}
      </div>
      {#if requestId}
        <p>
          Check the last status before sending another test if delivery is
          uncertain.
        </p>
      {/if}
      {@render troubleshooting()}
      <details class="channel-settings">
        <summary>Change Discord credentials</summary>
        {@render credentials()}
      </details>
      <details class="channel-settings">
        <summary>Disconnect Discord</summary>
        <p>
          Disconnecting Discord keeps the agent and its files. The bot remains
          in Discord.
        </p>
        <form onsubmit={remove} aria-busy={busy} aria-describedby="form-error">
          <label for="discord-confirm">Type {agent.id} to confirm removal</label
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
            ><Icon name="trash" size={16} />Remove Discord connection</ActionButton
          >
        </form>
      </details>
    {:else}
      <p>Discord is not configured.</p>
      {@render credentials()}
    {/if}
  </div>
</section>
