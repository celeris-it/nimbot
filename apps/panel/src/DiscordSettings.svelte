<script lang="ts">
  import { untrack } from "svelte";
  import type { AgentDetail } from "../../server/src/panel-contracts.js";
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

<section class="card" aria-label="Discord connection">
  <h2>Discord notifications</h2>
  <p>
    Optional Discord connection. Text messages join this agent's shared queue.
    Progress, approvals, and results return to the channel that received the
    task.
  </p>
  {#if agent.discord?.connection}
    <dl>
      <dt>Discord bot</dt>
      <dd>{agent.discord.connection.botUsername}</dd>
      <dt>Discord owner</dt>
      <dd>{agent.discord.connection.ownerId}</dd>
    </dl>
    <p>
      Send a fixed test message to the saved Discord owner. Up to five new
      notification attempts per minute are allowed.
    </p>
    <button class="btn" disabled={busy} onclick={() => testDelivery(true)}
      >Send Discord test</button
    >
    {#if requestId}
      <button class="btn" disabled={busy} onclick={() => testDelivery(false)}
        >Check last test status</button
      >
      <p>
        Checking reuses the last request and does not send it again. A new test
        may duplicate a message whose delivery was uncertain.
      </p>
    {/if}
  {:else}
    <p>Discord is not configured.</p>
  {/if}
  <form onsubmit={save} aria-busy={busy} aria-describedby="form-error">
    <label for="discord-owner">Owner's Discord user ID</label>
    <input
      class="input"
      id="discord-owner"
      name="ownerId"
      inputmode="numeric"
      pattern={"[1-9][0-9]{0,19}"}
      maxlength="20"
      required
      bind:value={ownerId}
      aria-describedby="discord-owner-help"
    />
    <p id="discord-owner-help">
      Enable Developer Mode in Discord and copy your user ID. Only this user's
      DMs will be used. The bot may need a shared server and permission to send
      you direct messages.
    </p>
    <label for="discord-token">Discord bot token</label>
    <input
      class="input"
      id="discord-token"
      name="token"
      type="password"
      autocomplete="off"
      maxlength="256"
      required
      bind:value={token}
      aria-describedby="discord-token-help"
    />
    <p id="discord-token-help">
      Create a bot in the Discord Developer Portal. Its token is stored
      privately and never shown here. Enter it again if saving fails.
    </p>
    <button class="btn" type="submit" disabled={busy}
      >{busy
        ? "Saving…"
        : agent.discord?.connection
          ? "Replace Discord connection"
          : "Connect Discord"}</button
    >
  </form>
  {#if agent.discord?.connection}
    <h3>Remove Discord</h3>
    <p>
      Disconnecting Discord keeps this agent, its files, and Telegram intact. It
      does not delete the bot in Discord.
    </p>
    <form onsubmit={remove} aria-busy={busy} aria-describedby="form-error">
      <label for="discord-confirm">Type {agent.id} to confirm removal</label>
      <input
        class="input"
        id="discord-confirm"
        name="confirm"
        autocomplete="off"
        required
        bind:value={confirmation}
      />
      <button
        class="btn"
        type="submit"
        disabled={busy || confirmation !== agent.id}
        >Remove Discord connection</button
      >
    </form>
  {/if}
</section>
