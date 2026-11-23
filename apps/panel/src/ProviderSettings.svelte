<script lang="ts">
  import { messages } from "./i18n/language.js";
  import { onMount, tick } from "svelte";
  import {
    ActionButton,
    Icon,
    PasswordField,
    StatusBadge,
  } from "./components/index.js";
  import type { ProviderSettings } from "../../server/src/panel/panel-contracts.js";
  let {
    settings,
    loadError,
    busy,
    action,
    refresh,
  }: {
    settings: ProviderSettings | undefined;
    loadError: string;
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
  let copiedMessage = $state<() => string>();
  const copied = $derived(copiedMessage?.() ?? "");
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
      copiedMessage = () => $messages("Code copied.");
    } catch {
      copiedMessage = () => $messages("Select and copy the code shown above.");
    }
  }
</script>

<div class="provider-page">
  <div class="provider-heading">
    <h1 id="ai-providers" tabindex="-1">{$messages("AI providers")}</h1>
    <p id="provider-help">
      {$messages(
        "All agents share these connections. Choose each agent’s model on its Model and usage page.",
      )}
    </p>
  </div>

  {#if !settings}
    <div class="panel-card provider-notice">
      <p role="status">
        {loadError || $messages("Provider settings unavailable.")}
      </p>
      <ActionButton onclick={refresh}
        ><Icon name="refresh" size={16} />{$messages(
          "Refresh provider settings",
        )}</ActionButton
      >
    </div>
  {:else}
    {#if settings.busy && !waiting}
      <p class="provider-message" role="status">
        {$messages("An authentication change is in progress.")}
      </p>
    {/if}
    {#if interrupted}
      <p class="provider-message" role="status">
        {$messages("The previous login was interrupted. Start a new login.")}
      </p>
    {/if}
    <div class="settings-section-list">
      {#each settings.providers as provider (provider.id)}
        {@const consoleProvider = provider.id === "opencode"}
        {@const deviceLogin = provider.id === "openai" || consoleProvider}
        {@const login =
          (settings.login?.provider ?? "openai") === provider.id
            ? settings.login
            : null}
        {@const state =
          provider.method === "device"
            ? $messages(
                "Configured — {0} device login",
                consoleProvider ? "OpenCode Console" : "ChatGPT",
              )
            : provider.reconnectRequired
              ? $messages("Reconnect required")
              : provider.method === "api_key"
                ? $messages("Configured — API key")
                : $messages("Not configured")}
        <section aria-labelledby={`provider-${provider.id}`}>
          <div class="settings-section-description provider-identity">
            <h2 id={`provider-${provider.id}`} tabindex="-1" class="card-title">
              <Icon name={provider.id} size={20} />{provider.name}
            </h2>
            <StatusBadge
              label={state}
              tone={provider.reconnectRequired
                ? "warning"
                : provider.method
                  ? "good"
                  : "neutral"}
            />
            {#if provider.reconnectRequired}
              <p>
                {$messages(
                  "Connect this provider again to use it with your agents.",
                )}
              </p>
            {/if}
          </div>
          <div class="panel-card">
            {#if !consoleProvider}
              <form
                class="provider-key"
                onsubmit={(event) => save(event, provider.id)}
                aria-busy={busy}
                aria-describedby="provider-help form-error"
              >
                <label for={`key-${provider.id}`}
                  >{provider.name} {$messages("API key")}</label
                >
                <div class="key-actions">
                  <PasswordField
                    id={`key-${provider.id}`}
                    name="key"
                    autocomplete="new-password"
                    spellcheck="false"
                    required
                    maxlength={4096}
                    bind:value={keys[provider.id]}
                    disabled={blocked}
                  />
                  <ActionButton
                    variant="primary"
                    type="submit"
                    disabled={blocked}
                  >
                    <Icon name="key" size={16} />
                    {provider.method
                      ? $messages("Replace with API key")
                      : $messages("Save API key")}
                  </ActionButton>
                </div>
              </form>
            {/if}

            {#if deviceLogin}
              <div class="device-settings" class:alternate={!consoleProvider}>
                {#if !consoleProvider}<h3>
                    {$messages("ChatGPT device sign-in")}
                  </h3>{/if}
                {#if !login || !waiting}
                  <p>
                    {consoleProvider
                      ? $messages(
                          "Connect a workspace to use its models, Console budgets and Go allowance.",
                        )
                      : $messages(
                          "A successful ChatGPT sign-in replaces the shared OpenAI credential. Failed or cancelled attempts keep it.",
                        )}
                  </p>
                  <ActionButton
                    variant={consoleProvider ? "primary" : "default"}
                    disabled={blocked}
                    onclick={() => {
                      interrupted = false;
                      copiedMessage = undefined;
                      void action(provider.id, "login");
                    }}
                    >{consoleProvider
                      ? $messages("Sign in to OpenCode Console")
                      : $messages("Sign in with ChatGPT")}</ActionButton
                  >
                {/if}
                {#if login}
                  <div class="device-status">
                    <div aria-live="polite">
                      {#if login.state === "starting"}
                        <p>{$messages("Starting device login…")}</p>
                      {:else if login.state === "awaiting_authorization"}
                        <p>{$messages("Waiting for authorization.")}</p>
                      {:else if login.state === "completed"}
                        <p>
                          {consoleProvider
                            ? $messages(
                                "OpenCode Console login completed for all agents.",
                              )
                            : $messages(
                                "ChatGPT login completed for all agents.",
                              )}
                        </p>
                      {:else if login.state === "cancelled"}
                        <p>
                          {$messages(
                            "Device login cancelled. The previous credential was kept.",
                          )}
                        </p>
                      {:else if login.state === "expired"}
                        <p>
                          {$messages(
                            "Device login exceeded its ten-minute time limit. Start a new login.",
                          )}
                        </p>
                      {:else}
                        <p>
                          {consoleProvider
                            ? $messages(
                                "Device login failed. Check your OpenCode Console workspace and try again.",
                              )
                            : $messages(
                                "Device login failed. Check that device code login is enabled in your ChatGPT account or workspace, then try again.",
                              )}
                        </p>
                      {/if}
                    </div>
                    {#if login.state === "awaiting_authorization"}
                      <p>
                        {$messages("Enter this code on the")}
                        <a
                          href={login.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {consoleProvider
                            ? $messages("OpenCode Console device authorization")
                            : $messages("OpenAI device authorization")}</a
                        >
                        {$messages("page (opens in a new tab).")}
                      </p>
                      <div class="device-code">
                        <code>{login.code}</code>
                        <ActionButton onclick={copy}
                          >{$messages("Copy code")}</ActionButton
                        >
                      </div>
                      <p aria-live="polite" class:sr-only={!copied}>{copied}</p>
                    {/if}
                    {#if waiting}
                      <ActionButton
                        disabled={busy}
                        onclick={() => action(provider.id, "cancel", login.id)}
                        >{$messages("Cancel device login")}</ActionButton
                      >
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}

            {#if provider.method}
              <div class="provider-disconnect">
                <ActionButton
                  disabled={blocked}
                  onclick={() => requestDisconnect(provider)}
                >
                  {$messages("Disconnect provider")}
                </ActionButton>
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
  onclose={(event) => {
    if (!event.currentTarget.open) disconnecting = undefined;
  }}
>
  <h2 id="provider-disconnect-title">
    {$messages("Disconnect {0}?", disconnecting?.name ?? "")}
  </h2>
  <p id="provider-disconnect-help">
    {$messages(
      "This removes the shared credential for all agents. Agents using this provider may be unable to run model tasks until it is reconnected.",
    )}
  </p>
  <div class="dialog-actions">
    <ActionButton onclick={() => disconnectDialog.close()}
      >{$messages("Keep connected")}</ActionButton
    >
    <ActionButton variant="danger" disabled={blocked} onclick={disconnect}
      >{$messages("Disconnect provider")}</ActionButton
    >
  </div>
</dialog>

<style>
  .provider-page {
    display: grid;
    gap: 24px;
  }
  .provider-heading {
    display: grid;
    gap: 8px;
  }
  .provider-heading p,
  .device-settings > p,
  .provider-dialog p {
    color: var(--color-muted);
  }
  .provider-identity {
    justify-items: start;
  }
  .provider-key {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .key-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 8px;
  }
  .key-actions > :global([data-ui="field-group"]) {
    flex: 1 1 13rem;
  }
  .device-settings {
    display: grid;
    justify-items: start;
    gap: 8px;
  }
  .device-settings h3 {
    font-size: 0.875rem;
    font-weight: 700;
  }
  .alternate,
  .provider-disconnect {
    border-block-start: 1px solid var(--color-base-300);
    padding-block-start: 16px;
  }
  .device-status,
  .provider-message {
    display: grid;
    justify-items: start;
    gap: 8px;
    width: 100%;
    padding: 16px;
    border: 1px solid var(--color-base-300);
    border-radius: 1rem;
    background: var(--color-base-200);
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
    gap: 8px;
  }
  .device-code code {
    padding: 8px 16px;
    border-radius: 0.5rem;
    background: var(--color-base-100);
    font-weight: 700;
    letter-spacing: 0.08em;
    overflow-wrap: anywhere;
    user-select: all;
  }
  .provider-notice {
    align-items: start;
    gap: 16px;
  }
  .provider-dialog {
    margin: auto;
    inline-size: min(27rem, calc(100% - 2 * var(--screen-gutter)));
    padding: 24px;
    border: 1px solid var(--color-base-300);
    border-radius: var(--radius-panel);
    background: var(--color-base-100);
    color: var(--color-base-content);
  }
  .provider-dialog::backdrop {
    background: rgb(0 0 0 / 65%);
  }
  .provider-dialog[open] {
    display: grid;
    gap: 16px;
  }
</style>
