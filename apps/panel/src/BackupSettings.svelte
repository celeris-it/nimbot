<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, request } from "./api.js";
  import {
    formattingLocale,
    messages,
    translateDescription,
    type MessageKey,
  } from "./i18n/language.js";
  import ActionButton from "./components/ActionButton.svelte";
  import type { BackupStatus } from "../../server/src/panel/panel-contracts.js";

  let { expireSession }: { expireSession: () => void } = $props();
  let backupState = $state<BackupStatus>();
  let selectedFile = $state<File>();
  let submitting = $state(false);
  let error = $state<() => string>();
  let fileError = $state<() => string>();
  let fileInput: HTMLInputElement;
  let fileButton = $state<HTMLButtonElement>();
  let mounted = false;
  let timer: ReturnType<typeof setTimeout>;
  const controller = new AbortController();
  const busy = $derived(
    submitting || backupState?.operation?.status === "running",
  );
  const blocked = $derived(busy || !backupState || backupState.maintenance);
  const phases: Record<string, MessageKey> = {
    pausing: "Pausing agents and services…",
    archiving: "Creating the backup…",
    validating: "Validating the backup…",
    uploading: "Uploading the backup…",
    reopening: "Starting agents and services…",
    restoring: "Restoring installation data…",
    rolling_back: "Recovering the previous installation…",
    completed: "Operation completed.",
    ready: "Backup ready.",
    failed: "Backup operation failed.",
  };

  function showError(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) {
      expireSession();
      return;
    }
    error = () =>
      cause instanceof ApiError
        ? translateDescription($messages, cause.display($messages))
        : $messages("Could not connect to the backup service. Try again.");
  }

  async function refresh() {
    try {
      const result = await request<BackupStatus>("/api/backups", {
        signal: controller.signal,
      });
      if (mounted) backupState = result;
    } catch (cause) {
      if (!controller.signal.aborted) showError(cause);
    }
  }

  onMount(() => {
    mounted = true;
    async function poll() {
      await refresh();
      if (mounted) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => {
      mounted = false;
      clearTimeout(timer);
      controller.abort();
    };
  });

  async function start(path: string, body?: BodyInit, upload = false) {
    if (blocked) return;
    submitting = true;
    error = undefined;
    try {
      await request(path, {
        method: "POST",
        body,
        headers: {
          "Content-Type": upload
            ? "application/octet-stream"
            : "application/json",
        },
        signal: controller.signal,
      });
      await refresh();
    } catch (cause) {
      if (!controller.signal.aborted) showError(cause);
    } finally {
      submitting = false;
    }
  }

  function createBackup() {
    if (
      blocked ||
      !window.confirm(
        $messages(
          "Pause agents and integrations to create a backup? Active tasks may be interrupted.",
        ),
      )
    )
      return;
    void start("/api/backups/export");
  }

  function uploadBackup() {
    if (blocked) return;
    if (!selectedFile) {
      fileError = () => $messages("Choose a backup file before validating.");
      fileButton?.focus();
      return;
    }
    if (selectedFile.size > backupState!.maxBytes) {
      fileError = () =>
        $messages("The selected backup exceeds the upload limit.");
      fileButton?.focus();
      return;
    }
    fileError = undefined;
    void start("/api/backups/upload", selectedFile, true);
  }

  function restoreBackup() {
    if (
      blocked ||
      !backupState?.restore ||
      !window.confirm(
        $messages(
          "Replace all installation data with this backup? Agents and integrations will pause. You will need to sign in again after restoration.",
        ),
      )
    )
      return;
    void start(
      "/api/backups/restore",
      JSON.stringify({ id: backupState.restore.id, confirm: true }),
    );
  }

  function date(value: string) {
    return new Date(value).toLocaleString($formattingLocale);
  }
</script>

<section aria-labelledby="panel-backups-heading">
  <div class="settings-section-description">
    <h2 id="panel-backups-heading" class="card-title">
      {$messages("Backups")}
    </h2>
    <p>
      {$messages("Save your installation or restore a previous backup.")}
    </p>
  </div>
  <div class="panel-card settings-card">
    {#if error}<p role="alert" data-tone="danger">{error()}</p>{/if}
    {#if backupState?.operation}
      <p role="status">
        {#if backupState.operation.status === "failed"}
          {$messages("Backup operation failed.")}
        {:else if backupState.operation.status === "ready" && backupState.operation.kind === "validate"}
          {$messages("Backup validated. Review its details before restoring.")}
        {:else}
          {$messages(
            phases[backupState.operation.phase] ?? "Processing backup…",
          )}
        {/if}
      </p>
      {#if backupState.operation.error}
        <p role="alert" data-tone="danger">
          {translateDescription($messages, backupState.operation.error)}
        </p>
      {/if}
    {:else if !backupState}
      <p role="status">{$messages("Loading backup status…")}</p>
    {/if}
    {#if backupState?.maintenance}
      <p role="status" data-tone="warning">
        {$messages(
          "Agents and integrations are paused. This operation continues if you leave the page.",
        )}
      </p>
    {/if}
    <div class="backup-options" aria-busy={busy}>
      <div class="backup-block" aria-labelledby="backup-create-heading">
        <h3 id="backup-create-heading">{$messages("Save a copy")}</h3>
        <p data-ui="muted">
          {$messages(
            "Download your agents’ files, conversations and settings.",
          )}
        </p>
        <p class="backup-note" data-ui="muted">
          {$messages(
            "Contains unencrypted secrets and browser sessions. Store it securely.",
          )}
        </p>
        <div class="button-row">
          <ActionButton
            variant="primary"
            disabled={blocked}
            onclick={createBackup}
          >
            {$messages("Create backup")}
          </ActionButton>
          {#if backupState?.download}
            <ActionButton
              href={`/api/backups/${encodeURIComponent(backupState.download.id)}/download`}
              download="nimbot-backup.tar.gz"
              disabled={busy}>{$messages("Download backup")}</ActionButton
            >
          {/if}
        </div>
        {#if backupState?.download}
          <p class="backup-note" data-ui="muted">
            {$messages(
              "Created {0}. Download before the next export, server restart or 24 hours.",
              date(backupState.download.createdAt),
            )}
          </p>
        {/if}
      </div>
      <form
        class="backup-block backup-restore"
        aria-labelledby="backup-restore-heading"
        onsubmit={(event) => {
          event.preventDefault();
          uploadBackup();
        }}
      >
        <h3 id="backup-restore-heading">{$messages("Restore from a file")}</h3>
        <p data-ui="muted">
          {$messages(
            "Choose a .tar.gz backup from the same Nimbot build. Your data is checked before restoration.",
          )}
        </p>
        <div class="backup-file-field">
          <label for="backup-file">{$messages("Backup file")}</label>
          <input
            bind:this={fileInput}
            id="backup-file"
            type="file"
            hidden
            accept=".tar.gz,application/gzip"
            disabled={blocked}
            aria-describedby={fileError
              ? "backup-file-help backup-file-error"
              : "backup-file-help"}
            aria-invalid={!!fileError}
            onchange={(event) => {
              selectedFile = event.currentTarget.files?.[0];
              error = undefined;
              fileError = undefined;
            }}
          />
          <div class="backup-file-picker">
            <ActionButton
              bind:element={fileButton}
              class="backup-choose-file"
              disabled={blocked}
              aria-describedby={fileError
                ? "backup-file-name backup-file-help backup-file-error"
                : "backup-file-name backup-file-help"}
              onclick={() => fileInput.click()}
              >{$messages("Choose file")}</ActionButton
            >
            <span id="backup-file-name" role="status" data-ui="muted"
              >{selectedFile?.name ?? $messages("No file selected")}</span
            >
          </div>
          <p id="backup-file-help" class="backup-note" data-ui="muted">
            {#if backupState}
              {$messages(
                "Maximum upload size {0} GiB.",
                (backupState.maxBytes / 1024 ** 3).toLocaleString(
                  $formattingLocale,
                ),
              )}
            {/if}
          </p>
          {#if fileError}<p
              id="backup-file-error"
              role="alert"
              data-tone="danger"
            >
              {fileError()}
            </p>{/if}
        </div>
        <ActionButton type="submit" disabled={blocked}>
          {$messages("Validate backup")}
        </ActionButton>
      </form>
    </div>
    {#if backupState?.restore}
      <div class="backup-preview">
        <h3>{$messages("Validated backup")}</h3>
        <dl>
          <dt>{$messages("Backup date")}</dt>
          <dd>{date(backupState.restore.manifest.createdAt)}</dd>
          <dt>{$messages("Nimbot build")}</dt>
          <dd>{backupState.restore.manifest.buildId}</dd>
          {#if backupState.restore.manifest.totalBytes != null}
            <dt>{$messages("Expanded size")}</dt>
            <dd>
              {(
                backupState.restore.manifest.totalBytes /
                1024 ** 2
              ).toLocaleString($formattingLocale)} MiB
            </dd>
          {/if}
        </dl>
        <p>
          {$messages(
            "Restoration replaces all installation data. A recovery copy is saved before applying changes.",
          )}
        </p>
        <ActionButton
          variant="danger"
          disabled={blocked}
          onclick={restoreBackup}
        >
          {$messages("Restore this backup")}
        </ActionButton>
      </div>
    {/if}
    <details class="backup-details">
      <summary>{$messages("Backup contents and requirements")}</summary>
      <p data-ui="muted">
        {$messages(
          "Includes files, conversations, private memory, schedules and saved credentials. Keep the deployment’s .env and Docker image separately.",
        )}
      </p>
      <p data-ui="muted">
        {$messages(
          "Runtime temporary files and engine caches are excluded. Tools may download dependencies again after restoration.",
        )}
      </p>
      <p data-ui="muted">
        {$messages(
          "Creating or restoring a backup pauses agents and integrations and may interrupt active tasks.",
        )}
      </p>
    </details>
  </div>
</section>

<style>
  .backup-options,
  .backup-block,
  .backup-file-field,
  .backup-preview {
    display: grid;
    gap: 12px;
    justify-items: start;
    width: 100%;
    overflow-wrap: anywhere;
  }
  .backup-block {
    align-content: start;
  }
  .backup-block p {
    max-inline-size: 65ch;
  }
  .backup-restore {
    border-block-start: 1px solid var(--color-base-300);
    padding-block-start: 24px;
  }
  .backup-restore > p {
    font-size: 0.875rem;
  }
  .backup-note {
    font-size: 0.875rem;
  }
  .backup-file-picker {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    min-inline-size: 0;
    max-inline-size: 100%;
  }
  .backup-file-picker :global(.backup-choose-file) {
    border-color: var(--color-field-border);
  }
  #backup-file-name {
    min-inline-size: 0;
    overflow-wrap: anywhere;
    font-size: 0.875rem;
  }
  .backup-details {
    border-block-start: 1px solid var(--color-base-300);
    padding-block-start: 16px;
    font-size: 0.875rem;
  }
  .backup-details summary {
    cursor: pointer;
    width: fit-content;
    padding-block: 8px;
  }
  .backup-details p {
    margin-block-start: 8px;
    max-inline-size: 72ch;
  }
  @container (width >= 900px) {
    .backup-options {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 24px;
    }
    .backup-restore {
      border-block-start: 0;
      padding-block-start: 0;
      border-inline-start: 1px solid var(--color-base-300);
      padding-inline-start: 24px;
    }
  }
  dl {
    display: grid;
    gap: 4px;
    max-width: 100%;
  }
  dt {
    font-weight: 600;
  }
  dd + dt {
    margin-block-start: 8px;
  }
</style>
