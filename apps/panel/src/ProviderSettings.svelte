<script lang="ts">
  import { onMount } from "svelte";
  import type { ProviderSettings } from "../../server/src/panel-contracts.js";
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
  async function copy() {
    try {
      await navigator.clipboard.writeText(settings?.login?.code ?? "");
      copied = "Code copied.";
    } catch {
      copied = "Select and copy the code shown above.";
    }
  }
</script>

<h1 tabindex="-1">AI providers</h1>
<p id="provider-help">
  All agents share these connections. Choose each agent’s model on its Model and
  usage page.
</p>
{#if !settings}
  <p role="status">Provider settings unavailable. Refresh to try again.</p>
  <button class="btn" onclick={refresh}>Refresh provider settings</button>
{:else}
  {#if settings.busy && !waiting}<p role="status">
      An authentication change is in progress.
    </p>{/if}
  {#if interrupted}<p role="status">
      The previous login was interrupted. Start a new login.
    </p>{/if}
  {#each settings.providers as provider (provider.id)}
    <section class="card" aria-label={provider.name}>
      <h2>{provider.name}</h2>
      <p>
        {provider.method === "device"
          ? provider.id === "opencode"
            ? "Configured — OpenCode Console device login"
            : "Configured — ChatGPT device login"
          : provider.reconnectRequired
            ? "Reconnect required"
            : provider.method === "api_key"
              ? "Configured — API key"
              : "Not configured"}
      </p>
      {#if provider.id !== "opencode"}
        <form
          onsubmit={(event) => save(event, provider.id)}
          aria-busy={busy}
          aria-describedby="provider-help form-error"
        >
          <label for={`key-${provider.id}`}>{provider.name} API key</label>
          <input
            class="input"
            id={`key-${provider.id}`}
            name="key"
            type="password"
            autocomplete="new-password"
            required
            maxlength="4096"
            bind:value={keys[provider.id]}
            disabled={blocked}
          />
          <button class="btn" type="submit" disabled={blocked}
            >{provider.method ? "Replace with API key" : "Save API key"}</button
          >
        </form>
      {/if}
      {#if provider.id === "openai" || provider.id === "opencode"}
        {#if provider.id === "openai"}
          <p>
            Or sign in with your ChatGPT account using a device code. A
            successful login replaces the shared OpenAI credential. Failed or
            cancelled attempts keep the current connection.
          </p>
        {:else}
          <p>
            Connect an OpenCode Console workspace to use its models, Console
            budgets and Go allowance.
          </p>
        {/if}
        <button
          class="btn"
          disabled={blocked}
          onclick={() => {
            interrupted = false;
            copied = "";
            void action(provider.id, "login");
          }}
          >{provider.id === "openai"
            ? "Sign in with ChatGPT"
            : "Sign in to OpenCode Console"}</button
        >
        {#if settings.login && (settings.login.provider ?? "openai") === provider.id}
          <div aria-live="polite">
            {#if settings.login.state === "starting"}<p>
                Starting device login…
              </p>
            {:else if settings.login.state === "awaiting_authorization"}
              <p>
                Open <a
                  href={settings.login.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  >{provider.id === "openai"
                    ? "OpenAI device authorization"
                    : "OpenCode Console device authorization"}</a
                > and enter this code:
              </p>
              <p><code>{settings.login.code}</code></p>
              <button class="btn" onclick={copy}>Copy code</button>
              <p>{copied}</p>
              <p>Waiting for authorization.</p>
            {:else if settings.login.state === "completed"}<p>
                {provider.id === "openai"
                  ? "ChatGPT login completed for all agents."
                  : "OpenCode Console login completed for all agents."}
              </p>
            {:else if settings.login.state === "cancelled"}<p>
                Device login cancelled. The previous credential was kept.
              </p>
            {:else if settings.login.state === "expired"}<p>
                Device login exceeded its ten-minute time limit. Start a new
                login.
              </p>
            {:else}<p>
                {provider.id === "openai"
                  ? "Device login failed. Check that device code login is enabled in your ChatGPT account or workspace, then try again."
                  : "Device login failed. Check your OpenCode Console workspace and try again."}
              </p>{/if}
          </div>
          {#if waiting}<button
              class="btn"
              disabled={busy}
              onclick={() => action(provider.id, "cancel", settings?.login?.id)}
              >Cancel device login</button
            >{/if}
        {/if}
      {/if}
      {#if provider.method}<button
          class="btn"
          disabled={blocked}
          onclick={() => action(provider.id, "remove")}
          >Disconnect provider</button
        >{/if}
    </section>
  {/each}
{/if}
