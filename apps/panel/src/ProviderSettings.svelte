<script lang="ts">
  import type { ProviderStatus } from "../../server/src/panel-contracts.js";
  let {
    providers,
    busy,
    action,
  }: {
    providers: ProviderStatus[];
    busy: boolean;
    action: (
      id: string,
      kind: "save" | "remove",
      key?: string,
    ) => Promise<void>;
  } = $props();
  let keys = $state<Record<string, string>>({
    openai: "",
    anthropic: "",
    google: "",
    openrouter: "",
  });
  async function save(event: SubmitEvent, id: string) {
    event.preventDefault();
    if (busy) return;
    const key = keys[id];
    keys[id] = "";
    await action(id, "save", key);
  }
</script>

<h1 tabindex="-1">AI providers</h1>
<p>
  API keys are shared by all agents in this installation, including new agents.
</p>
<p id="provider-help">
  Changes apply to the next task. Running tasks keep their current keys. Saving
  a key does not verify its validity, balance, or model access. OpenCode chooses
  the model automatically.
</p>
{#each providers as provider (provider.id)}
  <section class="card" aria-label={provider.name}>
    <h2>{provider.name}</h2>
    <p>{provider.configured ? "Configured" : "Not configured"}</p>
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
        disabled={busy}
      />
      <button class="btn" type="submit" disabled={busy}
        >{provider.configured ? "Replace API key" : "Save API key"}</button
      >
    </form>
    {#if provider.configured}
      <button
        class="btn"
        disabled={busy}
        onclick={() => action(provider.id, "remove")}>Remove API key</button
      >
    {/if}
  </section>
{/each}
<a class="btn" href="/">Back to panel</a>
