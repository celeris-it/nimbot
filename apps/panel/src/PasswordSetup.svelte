<script lang="ts">
  import type { PanelAuthStatus } from "../../server/src/panel/panel-contracts.js";
  import { onMount, tick } from "svelte";
  import { messages } from "./i18n/language.js";
  import { ApiError, post, request } from "./api.js";
  import { ActionButton, PasswordField } from "./components/index.js";
  import LanguageSelect from "./components/LanguageSelect.svelte";
  let { token, done }: { token: string; done: () => void } = $props();
  let pending = $state<boolean>();
  let password = $state("");
  let confirmation = $state("");
  let busy = $state(false);
  let failure = $state<unknown>();
  const error = $derived(
    failure instanceof ApiError
      ? failure.display($messages)
      : failure
        ? $messages(
            "The result could not be confirmed. Refresh the status before retrying.",
          )
        : "",
  );
  async function refresh() {
    failure = undefined;
    try {
      pending = (await request<PanelAuthStatus>("/api/auth/status"))
        .setupRequired;
    } catch (cause) {
      failure = cause;
    }
  }
  onMount(() => {
    void refresh();
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    failure = undefined;
    try {
      await post("/api/auth/setup", { token, password, confirmation });
      password = "";
      confirmation = "";
      done();
    } catch (cause) {
      if (!(cause instanceof ApiError) || cause.status >= 500) {
        const session = await request("/api/session").catch(() => undefined);
        if (session) {
          password = "";
          confirmation = "";
          done();
          return;
        }
      }
      failure = cause;
      if (cause instanceof ApiError && cause.code === "setup_complete")
        pending = false;
      await tick();
      document.getElementById("form-error")?.focus();
    } finally {
      busy = false;
    }
  }
</script>

<section
  data-ui="sign-in"
  aria-label={$messages("Create administrator password")}
>
  <small>{$messages("ADMINISTRATION")}</small>
  <h1 tabindex="-1">{$messages("Create administrator password")}</h1>
  <div data-ui="sign-in-language">
    <label for="setup-language">{$messages("Language")}</label>
    <LanguageSelect id="setup-language" />
  </div>
  <p id="form-error" role="alert" tabindex="-1">{error}</p>
  {#if pending === undefined}
    <p role="status">{$messages("Loading…")}</p>
    {#if failure}<ActionButton onclick={refresh}
        >{$messages("Retry")}</ActionButton
      >{/if}
  {:else if !pending}
    <p>
      {$messages(
        "The administrator password is already configured. Sign in to continue.",
      )}
    </p>
    <ActionButton href="/login"
      >{$messages("Sign in to the panel")}</ActionButton
    >
  {:else if !token}
    <p>
      {$messages(
        "Open the activation link shown by the installer. To get it again, run the setup-link command on your server.",
      )}
    </p>
  {:else}
    <p>
      {$messages("Choose a password to protect your administration panel.")}
    </p>
    <div class="panel-card">
      <form onsubmit={save} aria-describedby="form-error" aria-busy={busy}>
        <label for="setup-password">{$messages("Administrator password")}</label
        >
        <PasswordField
          id="setup-password"
          name="password"
          autocomplete="new-password"
          required
          minlength={8}
          maxlength={256}
          bind:value={password}
          aria-describedby="setup-help form-error"
          aria-invalid={error ? "true" : undefined}
        />
        <p id="setup-help">
          {$messages(
            "Use 8–256 characters. You can paste a password from your password manager.",
          )}
        </p>
        <label for="setup-confirmation">{$messages("Confirm password")}</label>
        <PasswordField
          id="setup-confirmation"
          name="confirmation"
          autocomplete="new-password"
          required
          minlength={8}
          maxlength={256}
          bind:value={confirmation}
          aria-describedby="form-error"
          aria-invalid={error ? "true" : undefined}
        />
        <ActionButton variant="primary" type="submit" disabled={busy}>
          {busy
            ? $messages("Saving…")
            : $messages("Save password and open panel")}
        </ActionButton>
      </form>
    </div>
  {/if}
</section>
