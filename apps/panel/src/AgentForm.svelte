<script lang="ts">
  import { messages } from "./i18n/language.js";
  import {
    ActionButton,
    PasswordField,
    TextField,
  } from "./components/index.js";
  import { untrack } from "svelte";
  import type { AgentDetail } from "../../server/src/panel/panel-contracts.js";
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
  let token = $state("");
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    const fields: Record<string, string> =
      mode === "token" ? { token } : { name, instructions };
    token = "";
    await submit(fields);
  }
</script>

{#if mode === "new"}
  <h1 tabindex="-1">{$messages("Create agent.")}</h1>
  <p>
    {$messages(
      "Connect Telegram or Discord from Channels after creating the agent.",
    )}
  </p>
{:else if mode === "settings"}
  <h1 id="agent-settings" tabindex="-1">{$messages("Edit agent.")}</h1>
  <p>
    {$messages(
      "Changes apply to upcoming tasks. The name is local to Nimbot; it does not change the bot's profile on Telegram.",
    )}
  </p>
{:else}
  <h1 tabindex="-1">{$messages("Bot token.")}</h1>
  <p>{$messages("Agent:")} {agent?.name}</p>
  <p>
    {$messages(
      "Only a new token for the same bot, created in BotFather, is accepted. Restart this agent after saving to reconnect its bot.",
    )}
  </p>
{/if}
<section
  class="panel-card"
  aria-label={mode === "token"
    ? $messages("Bot credential")
    : $messages("Agent settings")}
>
  <form onsubmit={send} aria-describedby="form-error" aria-busy={busy}>
    {#if mode !== "token"}
      <label for="name">{$messages("Name")}</label>
      <TextField
        id="name"
        name="name"
        maxlength={128}
        required
        bind:value={name}
      />
      <label for="instructions">{$messages("Instructions (optional)")}</label>
      <textarea
        class="panel-textarea"
        id="instructions"
        name="instructions"
        rows="8"
        maxlength={4000}
        aria-describedby="instructions-help"
        bind:value={instructions}></textarea>
      <p id="instructions-help">
        {$messages(
          "Up to 4000 characters. They are sent as context with every task. Do not include passwords or tokens.",
        )}
      </p>
    {/if}
    {#if mode === "token"}
      <label for="token">{$messages("New Telegram token")}</label>
      <PasswordField
        id="token"
        name="token"
        required
        maxlength={256}
        autocomplete="off"
        aria-describedby="token-help"
        bind:value={token}
      />
      <p id="token-help">
        {$messages(
          "The token is saved privately without being shown in the panel. Enter it again if the operation fails.",
        )}
      </p>
    {/if}
    <ActionButton variant="primary" type="submit" disabled={busy}
      >{busy
        ? $messages("Saving…")
        : mode === "new"
          ? $messages("Create agent")
          : mode === "token"
            ? $messages("Save token")
            : $messages("Save changes")}</ActionButton
    >
    <ActionButton
      variant="ghost"
      href={agent
        ? `/agents/${encodeURIComponent(agent.id)}/${mode === "token" ? "channels" : "setup"}`
        : "/"}
      >{mode === "new"
        ? $messages("Cancel")
        : mode === "token"
          ? $messages("Back to channels")
          : $messages("Back to agent")}</ActionButton
    >
  </form>
</section>
