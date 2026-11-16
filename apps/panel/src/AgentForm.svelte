<script lang="ts">
  import { untrack } from "svelte";
  import type { AgentDetail } from "../../server/src/panel-contracts.js";
  let {
    mode,
    agent,
    busy,
    submit,
  }: {
    mode: "new" | "settings" | "token";
    agent?: AgentDetail;
    busy: boolean;
    submit: (fields: Record<string, string>) => Promise<void>;
  } = $props();
  // Form state belongs to this route and is never replaced by status polling.
  let name = $state(untrack(() => agent?.settings?.name ?? ""));
  let instructions = $state(untrack(() => agent?.settings?.instructions ?? ""));
  let ownerId = $state("");
  let token = $state("");
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    const fields =
      mode === "token"
        ? { token }
        : mode === "settings"
          ? { name, instructions }
          : { name, instructions, ownerId, token };
    token = "";
    await submit(fields as Record<string, string>);
  }
</script>

{#if mode === "new"}
  <h1 tabindex="-1">Create agent.</h1>
  <p>
    Create a separate bot in BotFather first. One Telegram bot belongs to one
    agent.
  </p>
{:else if mode === "settings"}
  <h1 tabindex="-1">Edit agent.</h1>
  <p>
    Changes apply to upcoming tasks. The name is local to Nimbot; it does not
    change the bot's profile on Telegram.
  </p>
{:else}
  <h1 tabindex="-1">Bot token.</h1>
  <p>Agent: {agent?.name}</p>
  <p>
    Only a new token for the same bot, created in BotFather, is accepted. If the
    bot is already connected, restart the server to apply the change.
  </p>
{/if}
<section
  class="card"
  aria-label={mode === "token" ? "Bot credential" : "Agent settings"}
>
  <form onsubmit={send} aria-describedby="form-error" aria-busy={busy}>
    {#if mode !== "token"}
      <label for="name">Name</label>
      <input
        class="input"
        id="name"
        name="name"
        maxlength="128"
        required
        bind:value={name}
      />
      <label for="instructions">Instructions (optional)</label>
      <textarea
        class="textarea"
        id="instructions"
        name="instructions"
        rows="8"
        maxlength="4000"
        aria-describedby="instructions-help"
        bind:value={instructions}></textarea>
      <p id="instructions-help">
        Up to 4000 characters. They are sent as context with every task. Do not
        include passwords or tokens.
      </p>
    {/if}
    {#if mode === "new"}
      <label for="ownerId">Owner's Telegram ID</label>
      <input
        class="input"
        id="ownerId"
        name="ownerId"
        inputmode="numeric"
        pattern="[1-9][0-9]*"
        required
        aria-describedby="owner-help"
        bind:value={ownerId}
      />
      <p id="owner-help">
        Enter your numeric Telegram user ID. Only that user can use this agent.
      </p>
    {/if}
    {#if mode !== "settings"}
      <label for="token"
        >{mode === "token" ? "New Telegram token" : "Telegram bot token"}</label
      >
      <input
        class="input"
        type="password"
        id="token"
        name="token"
        required
        maxlength="256"
        autocomplete="off"
        aria-describedby="token-help"
        bind:value={token}
      />
      <p id="token-help">
        The token is saved privately without being shown in the panel. Enter it
        again if the operation fails.
      </p>
    {/if}
    {#if mode === "new"}<p>
        On creation, the bot is verified and its container is prepared. This can
        take a few seconds. The server connects the bot after provisioning
        completes; the owner must then send /start.
      </p>{/if}
    <button class="btn" type="submit" disabled={busy}
      >{busy
        ? "Saving…"
        : mode === "new"
          ? "Create agent"
          : mode === "token"
            ? "Save token"
            : "Save changes"}</button
    >
    <a
      class="btn"
      href={agent ? `/agents/${encodeURIComponent(agent.id)}/setup` : "/"}
      >{mode === "new" ? "Cancel" : "Back to agent"}</a
    >
  </form>
</section>
