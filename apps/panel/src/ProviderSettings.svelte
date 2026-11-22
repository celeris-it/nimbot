<script lang="ts">
  import { onMount, tick } from "svelte";
  import { StatusBadge } from "./components/index.js";
  import type { ProviderSettings } from "../../server/src/panel/panel-contracts.js";
  let {
    settings,
    busy,
    action,
    refresh,
  }: {
    settings: ProviderSettings | undefined;
    busy: boolean;
    action: (
      id: string,
      kind: "save" | "remove" | "login" | "cancel",
      value?: string,
    ) => Promise<void>;
    refresh: () => void;
  } = $props();
  let keys = $state<Record<string, string>>({
    openai: "",
    anthropic: "",
    google: "",
    openrouter: "",
  });
  let disconnectDialog: HTMLDialogElement;
  let disconnecting = $state<ProviderSettings["providers"][number]>();
  let copied = $state("");
  let interrupted = $state(false);
  let waiting = $derived(
    settings?.login?.state === "starting" ||
      settings?.login?.state === "awaiting_authorization",
  );
  let blocked = $derived(busy || !settings || settings.busy);
  $effect(() => {
    if (!settings) return;
    const storageKey = "nimbot-provider-login";
    try {
      const previous = sessionStorage.getItem(storageKey);
      if (previous && previous !== settings.login?.id) interrupted = true;
      if (waiting && settings.login)
        sessionStorage.setItem(storageKey, settings.login.id);
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* Login works even if browser storage is disabled. */
    }
  });
  onMount(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !busy) refresh();
    }, 2000);
    return () => clearInterval(timer);
  });
  async function save(event: SubmitEvent, id: string) {
    event.preventDefault();
    if (blocked) return;
    const key = keys[id];
    keys[id] = "";
    await action(id, "save", key);
  }
  async function requestDisconnect(
    provider: ProviderSettings["providers"][number],
  ) {
    disconnecting = provider;
    await tick();
    disconnectDialog.showModal();
  }
  function disconnect() {
    if (blocked || !disconnecting) return;
    const id = disconnecting.id;
    disconnectDialog.close();
    void action(id, "remove");
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(settings?.login?.code ?? "");
      copied = "Code copied.";
    } catch {
      copied = "Select and copy the code shown above.";
    }
  }
</script>

<div class="provider-page">
  <div class="provider-heading">
    <h1 tabindex="-1">AI providers</h1>
    <p id="provider-help">
      All agents share these connections. Choose each agent’s model on its Model
      and usage page.
    </p>
  </div>

  {#if !settings}
    <div class="panel-card provider-notice">
      <p role="status">Provider settings unavailable. Refresh to try again.</p>
      <button class="panel-button" onclick={refresh}
        >Refresh provider settings</button
      >
    </div>
  {:else}
    {#if settings.busy && !waiting}
      <p class="provider-message" role="status">
        An authentication change is in progress.
      </p>
    {/if}
    {#if interrupted}
      <p class="provider-message" role="status">
        The previous login was interrupted. Start a new login.
      </p>
    {/if}
    <div class="provider-list">
      {#each settings.providers as provider (provider.id)}
        {@const consoleProvider = provider.id === "opencode"}
        {@const deviceLogin = provider.id === "openai" || consoleProvider}
        {@const login =
          (settings.login?.provider ?? "openai") === provider.id
            ? settings.login
            : null}
        {@const state =
          provider.method === "device"
            ? `Configured — ${consoleProvider ? "OpenCode Console" : "ChatGPT"} device login`
            : provider.reconnectRequired
              ? "Reconnect required"
              : provider.method === "api_key"
                ? "Configured — API key"
                : "Not configured"}
        <section
          class="panel-card provider-card"
          aria-labelledby={`provider-${provider.id}`}
        >
          <div class="provider-identity">
            <h2 id={`provider-${provider.id}`}>{provider.name}</h2>
            <StatusBadge
              label={state}
              tone={provider.reconnectRequired
                ? "warning"
                : provider.method
                  ? "good"
                  : "neutral"}
            />
            {#if provider.reconnectRequired}
              <p>Connect this provider again to use it with your agents.</p>
            {/if}
          </div>
          <div class="provider-controls">
            {#if !consoleProvider}
              <form
                class="provider-key"
                onsubmit={(event) => save(event, provider.id)}
                aria-busy={busy}
                aria-describedby="provider-help form-error"
              >
                <label for={`key-${provider.id}`}>{provider.name} API key</label
                >
                <div class="key-actions">
                  <input
                    class="panel-input"
                    id={`key-${provider.id}`}
                    name="key"
                    type="password"
                    autocomplete="new-password"
                    spellcheck="false"
                    required
                    maxlength="4096"
                    bind:value={keys[provider.id]}
                    disabled={blocked}
                  />
                  <button
                    class="panel-button panel-button-primary"
                    type="submit"
                    disabled={blocked}
                  >
                    {provider.method ? "Replace with API key" : "Save API key"}
                  </button>
                </div>
              </form>
            {/if}

            {#if deviceLogin}
              <div class="device-settings" class:alternate={!consoleProvider}>
                {#if !consoleProvider}<h3>ChatGPT device sign-in</h3>{/if}
                {#if !login || !waiting}
                  <p>
                    {consoleProvider
                      ? "Connect a workspace to use its models, Console budgets and Go allowance."
                      : "A successful ChatGPT sign-in replaces the shared OpenAI credential. Failed or cancelled attempts keep it."}
                  </p>
                  <button
                    class="panel-button"
                    class:panel-button-primary={consoleProvider}
                    disabled={blocked}
                    onclick={() => {
                      interrupted = false;
                      copied = "";
                      void action(provider.id, "login");
                    }}
                    >{consoleProvider
                      ? "Sign in to OpenCode Console"
                      : "Sign in with ChatGPT"}</button
                  >
                {/if}
                {#if login}
                  <div class="device-status">
                    <div aria-live="polite">
                      {#if login.state === "starting"}
                        <p>Starting device login…</p>
                      {:else if login.state === "awaiting_authorization"}
                        <p>Waiting for authorization.</p>
                      {:else if login.state === "completed"}
                        <p>
                          {consoleProvider
                            ? "OpenCode Console login completed for all agents."
                            : "ChatGPT login completed for all agents."}
                        </p>
                      {:else if login.state === "cancelled"}
                        <p>
                          Device login cancelled. The previous credential was
                          kept.
                        </p>
                      {:else if login.state === "expired"}
                        <p>
                          Device login exceeded its ten-minute time limit. Start
                          a new login.
                        </p>
                      {:else}
                        <p>
                          {consoleProvider
                            ? "Device login failed. Check your OpenCode Console workspace and try again."
                            : "Device login failed. Check that device code login is enabled in your ChatGPT account or workspace, then try again."}
                        </p>
                      {/if}
                    </div>
                    {#if login.state === "awaiting_authorization"}
                      <p>
                        Enter this code on the <a
                          href={login.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {consoleProvider
                            ? "OpenCode Console device authorization"
                            : "OpenAI device authorization"}</a
                        > page (opens in a new tab).
                      </p>
                      <div class="device-code">
                        <code>{login.code}</code>
                        <button class="panel-button" onclick={copy}
                          >Copy code</button
                        >
                      </div>
                      <p aria-live="polite" class:sr-only={!copied}>{copied}</p>
                    {/if}
                    {#if waiting}
                      <button
                        class="panel-button"
                        disabled={busy}
                        onclick={() => action(provider.id, "cancel", login.id)}
                        >Cancel device login</button
                      >
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}

            {#if provider.method}
              <div class="provider-disconnect">
                <button
                  class="panel-button"
                  disabled={blocked}
                  onclick={() => requestDisconnect(provider)}
                >
                  Disconnect provider
                </button>
              </div>
            {/if}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>

<dialog
  class="provider-dialog"
  bind:this={disconnectDialog}
  aria-labelledby="provider-disconnect-title"
  aria-describedby="provider-disconnect-help"
  onclose={() => (disconnecting = undefined)}
>
  <h2 id="provider-disconnect-title">Disconnect {disconnecting?.name}?</h2>
  <p id="provider-disconnect-help">
    This removes the shared credential for all agents. Agents using this
    provider may be unable to run model tasks until it is reconnected.
  </p>
  <div class="dialog-actions">
    <button class="panel-button" onclick={() => disconnectDialog.close()}
      >Keep connected</button
    >
    <button
      class="panel-button disconnect-confirm"
      disabled={blocked}
      onclick={disconnect}>Disconnect provider</button
    >
  </div>
</dialog>

<style>
  .provider-page {
    max-width: 66rem;
  }
  .provider-heading {
    display: grid;
    gap: 0.5rem;
    margin-bottom: 1.75rem;
  }
  .provider-heading p,
  .provider-identity p,
  .device-settings > p,
  .provider-dialog p {
    color: var(--color-muted);
  }
  .provider-list,
  .provider-controls {
    display: grid;
    gap: 1rem;
    min-width: 0;
  }
  .provider-card {
    display: grid;
    grid-template-columns: minmax(11rem, 1fr) minmax(0, 2.4fr);
    gap: 1.25rem;
    align-items: start;
  }
  .provider-identity {
    display: grid;
    justify-items: start;
    gap: 0.5rem;
    min-width: 0;
  }
  .provider-identity h2 {
    font-size: 1.125rem;
    font-weight: 700;
  }
  .provider-card :is(.provider-identity, .provider-controls) p {
    margin: 0;
  }
  .provider-key {
    gap: 0.35rem;
  }
  .key-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.5rem;
  }
  .key-actions input {
    flex: 1 1 13rem;
  }
  .device-settings {
    display: grid;
    justify-items: start;
    gap: 0.5rem;
  }
  .device-settings h3 {
    font-size: 0.875rem;
    font-weight: 700;
  }
  .alternate,
  .provider-disconnect {
    border-top: 1px solid var(--color-base-300);
    padding-top: 0.875rem;
  }
  .device-status,
  .provider-message {
    display: grid;
    justify-items: start;
    gap: 0.625rem;
    width: 100%;
    padding: 0.875rem;
    border: 1px solid var(--color-base-300);
    border-radius: 1rem;
    background: var(--color-base-200);
  }
  .provider-message {
    margin-bottom: 1rem;
  }
  .device-status a {
    color: var(--color-primary);
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  .device-code,
  .dialog-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .device-code code {
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--color-base-100);
    font-weight: 700;
    letter-spacing: 0.08em;
    overflow-wrap: anywhere;
    user-select: all;
  }
  .provider-disconnect button,
  .disconnect-confirm {
    color: var(--color-error);
  }
  .provider-notice {
    align-items: start;
    gap: 0.75rem;
  }
  .provider-dialog {
    margin: auto;
    width: min(27rem, calc(100% - 2rem));
    padding: 1.25rem;
    border: 1px solid var(--color-base-300);
    border-radius: var(--radius-panel);
    background: var(--color-base-100);
    color: var(--color-base-content);
  }
  .provider-dialog::backdrop {
    background: rgb(0 0 0 / 65%);
  }
  .provider-dialog p {
    margin-block: 0.5rem 1rem;
  }
  @media (max-width: 760px) {
    .provider-card {
      grid-template-columns: minmax(0, 1fr);
      gap: 1rem;
    }
  }
</style>
