<script lang="ts">
  import { formattingLocale, messages } from "./i18n/language.js";
  import {
    ActionButton,
    Checkbox,
    Icon,
    NumberStepper,
    Select,
    TextField,
  } from "./components/index.js";
  import { ApiError, request, post } from "./api.js";
  import { translateScheduleError } from "./i18n/errors.js";
  import { tick } from "svelte";
  import {
    nextRuns,
    validateTimeZone,
    parseCronExpression,
  } from "../../server/src/schedules/schedule-time.js";
  import type {
    AgentDetail,
    Schedule,
    ScheduleList,
    ScheduleSettings,
  } from "../../server/src/panel/panel-contracts.js";
  import {
    scheduleText,
    scheduleKinds,
    scheduleWeekdays,
    scheduleCadenceLabel,
    scheduleTimeLabel,
    scheduleStateLabel,
    scheduleRunLabel,
  } from "./labels.js";

  let {
    agent,
    data,
    busy,
    save,
    action,
    refresh,
  }: {
    agent: AgentDetail;
    data: ScheduleList;
    busy: boolean;
    save: (settings: ScheduleSettings, id?: string) => Promise<boolean>;
    action: (
      id: string,
      kind: "pause" | "resume" | "run" | "remove",
    ) => Promise<boolean>;
    refresh: () => void;
  } = $props();
  // Polling updates the list, never an open form's draft.
  let webhook = $state<{ id: string; url: string; token: string }>();
  let webhookBusy = $state(false);
  let webhookErrorMessage = $state<() => string>();
  const webhookError = $derived(webhookErrorMessage?.() ?? "");
  async function loadWebhook(id: string, rotate = false) {
    if (webhookBusy || busy) return;
    if (rotate && !window.confirm(text.webhookRotateConfirm)) return;
    webhookBusy = true;
    webhookErrorMessage = undefined;
    try {
      const path = `/api/agents/${encodeURIComponent(agent.id)}/schedules/${encodeURIComponent(id)}/webhook`;
      const result = rotate
        ? await post<{ url: string; token: string }>(`${path}/rotate`, {})
        : await request<{ url: string; token: string }>(path);
      webhook = { id, ...result };
    } catch (error) {
      webhookErrorMessage = () =>
        error instanceof ApiError
          ? error.display($messages)
          : text.webhookError;
    } finally {
      webhookBusy = false;
    }
  }
  let formVisible = $state(false);
  let editId = $state<string>();
  let name = $state("");
  let prompt = $state("");
  let kind = $state<ScheduleSettings["cadence"]["kind"]>("daily");
  let date = $state("");
  let time = $state("09:00");
  let weekdays = $state<number[]>([]);
  let minutes = $state<number | undefined>(15);
  let expression = $state("");
  let cronTouched = $state(false);
  let timeZone = $state("");
  let deliveryChannel = $state<ScheduleSettings["deliveryChannel"]>("telegram");
  const channelLabel = { telegram: "Telegram", discord: "Discord" };
  const linked = (channel: ScheduleSettings["deliveryChannel"]) =>
    channel === "telegram" ? data.ownerLinked : data.discordOwnerLinked;
  const text = $derived(scheduleText($messages));
  let invalid = $state<"weekdays" | "zone" | undefined>();
  const localError = $derived(
    invalid === "weekdays"
      ? text.weekdayError
      : invalid === "zone"
        ? text.zoneError
        : "",
  );
  let atLimit = $derived(data.schedules.length >= data.limits.maxPerAgent);

  const cronPreview = $derived.by(() => {
    if (!formVisible || kind !== "cron") return {};
    try {
      parseCronExpression(expression);
    } catch (error) {
      return { error: translateScheduleError($messages, error) };
    }
    try {
      validateTimeZone(timeZone);
    } catch {
      return {};
    }
    const runs = nextRuns(
      { kind: "cron", expression },
      timeZone,
      Date.now(),
      5,
    );
    return runs.length
      ? { runs }
      : { error: $messages("Schedule must have an occurrence in the future.") };
  });

  $effect(() => {
    if (invalid === "weekdays" && (kind !== "weekly" || weekdays.length > 0)) {
      invalid = undefined;
    } else if (invalid === "zone") {
      try {
        validateTimeZone(timeZone);
        invalid = undefined;
      } catch {
        /* Keep the explanation until the time zone is valid. */
      }
    }
  });

  async function openForm(schedule?: Schedule) {
    editId = schedule?.id;
    name = schedule?.name ?? "";
    prompt = schedule?.prompt ?? "";
    kind = schedule?.cadence.kind ?? "daily";
    date = schedule?.cadence.kind === "once" ? schedule.cadence.date : "";
    time =
      schedule && "time" in schedule.cadence ? schedule.cadence.time : "09:00";
    weekdays =
      schedule?.cadence.kind === "weekly" ? [...schedule.cadence.weekdays] : [];
    minutes =
      schedule?.cadence.kind === "interval"
        ? schedule.cadence.minutes
        : data.limits.minIntervalMinutes;
    expression =
      schedule?.cadence.kind === "cron" ? schedule.cadence.expression : "";
    cronTouched = false;
    deliveryChannel =
      schedule?.deliveryChannel ??
      (data.discordOwnerLinked && !data.ownerLinked ? "discord" : "telegram");
    timeZone = schedule?.timeZone ?? data.defaultTimeZone;

    invalid = undefined;
    formVisible = true;
    await tick();
    document.getElementById("schedule-name")?.focus();
  }
  async function closeForm() {
    formVisible = false;
    editId = undefined;

    invalid = undefined;
    await tick();
    const button = document.getElementById(
      "new-schedule",
    ) as HTMLButtonElement | null;
    (button && !button.disabled
      ? button
      : document.querySelector<HTMLElement>("h1")
    )?.focus();
  }
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;

    invalid = undefined;
    if (kind === "weekly" && weekdays.length === 0) {
      invalid = "weekdays";
    } else if (kind !== "webhook") {
      try {
        validateTimeZone(timeZone);
      } catch {
        invalid = "zone";
      }
    }
    if (localError) {
      await tick();
      document.getElementById("schedule-form-error")?.focus();
      return;
    }
    if (kind === "cron" && cronPreview.error) {
      cronTouched = true;
      await tick();
      document.getElementById("schedule-cron")?.focus();
      return;
    }
    const cadence: ScheduleSettings["cadence"] =
      kind === "webhook"
        ? { kind }
        : kind === "once"
          ? { kind, date, time }
          : kind === "weekly"
            ? { kind, weekdays: [...weekdays], time }
            : kind === "interval"
              ? { kind, minutes: minutes ?? 0 }
              : kind === "cron"
                ? { kind, expression }
                : { kind, time };
    if (
      await save(
        {
          name,
          prompt,
          timeZone: kind === "webhook" ? "UTC" : timeZone,
          cadence,
          deliveryChannel,
        },
        editId,
      )
    )
      await closeForm();
  }
  async function remove(schedule: Schedule) {
    if (busy || !window.confirm(text.confirm(schedule.name))) return;
    if (await action(schedule.id, "remove")) {
      if (editId === schedule.id) await closeForm();
      else {
        await tick();
        document.getElementById("new-schedule")?.focus();
      }
    }
  }
</script>

<div data-ui="schedules">
  <div data-ui="page-heading" class="flex-wrap">
    <h1 id="agent-schedules" tabindex="-1">{text.title(agent.name)}</h1>
    <div data-ui="schedule-actions">
      <ActionButton
        variant="primary"
        id="new-schedule"
        disabled={busy || atLimit}
        onclick={() => openForm()}
        aria-describedby={atLimit ? "schedule-limit" : undefined}
        >{text.new}</ActionButton
      >
      <ActionButton disabled={busy} onclick={refresh}
        >{text.refresh}</ActionButton
      >
    </div>
  </div>
  {#if webhookError}<p role="alert">{webhookError}</p>{/if}
  <p id="schedule-costs">{text.costs}</p>
  {#if !data.ownerLinked && !data.discordOwnerLinked}
    <p role="status" data-ui="schedule-warning">
      {$messages("Owner chat is not linked.")}
      <a
        class="underline"
        href={`/agents/${encodeURIComponent(agent.id)}/channels`}
        >{$messages("Open Channels")}</a
      >
      {$messages("for linking instructions.")}
    </p>
  {/if}
  <p data-ui="muted">
    {text.count(data.schedules.length, data.limits.maxPerAgent)}
  </p>
  {#if atLimit}<p id="schedule-limit" role="status">{text.limit}</p>{/if}
  {#if formVisible}
    <section class="panel-card" aria-labelledby="schedule-form-heading">
      <h2 id="schedule-form-heading">{editId ? text.editTitle : text.new}</h2>
      {#if editId}<p>{text.editHelp}</p>{/if}
      <form
        onsubmit={send}
        aria-busy={busy}
        aria-describedby="schedule-costs form-error schedule-form-error"
      >
        <p id="schedule-form-error" role="alert" tabindex="-1">{localError}</p>
        <fieldset class="schedule-fields" disabled={busy}>
          <label for="schedule-name">{text.name}</label>
          <TextField
            id="schedule-name"
            name="name"
            required
            maxlength={data.limits.maxNameLength}
            bind:value={name}
          />
          <label for="schedule-prompt">{text.prompt}</label>
          <textarea
            class="panel-textarea"
            id="schedule-prompt"
            name="prompt"
            required
            maxlength={data.limits.maxPromptLength}
            rows="5"
            aria-describedby="schedule-prompt-help"
            bind:value={prompt}></textarea>
          <p id="schedule-prompt-help">{text.promptHelp}</p>
          <label for="schedule-delivery">{$messages("Delivery channel")}</label>
          <Select id="schedule-delivery" bind:value={deliveryChannel}>
            <option value="telegram">Telegram</option>
            <option value="discord">Discord</option>
          </Select>
          {#if !linked(deliveryChannel)}
            <p role="status" data-ui="schedule-warning">
              {$messages("Link the")}
              {channelLabel[deliveryChannel]}
              {$messages("owner chat to run this schedule.")}
            </p>
          {/if}
          <label for="schedule-kind">{text.kind}</label>
          <Select id="schedule-kind" bind:value={kind}>
            {#each Object.entries(scheduleKinds) as [value, label] (value)}<option
                {value}>{label}</option
              >{/each}
          </Select>
          {#if kind === "once"}
            <label for="schedule-date">{text.date}</label>
            <TextField
              id="schedule-date"
              type="date"
              required
              aria-describedby="schedule-date-help"
              bind:value={date}
            />
            <p id="schedule-date-help">{text.dateHelp}</p>
          {/if}
          {#if kind === "cron"}
            <label for="schedule-cron">{$messages(scheduleKinds.cron)}</label>
            <TextField
              class="font-mono"
              id="schedule-cron"
              required
              maxlength={data.limits.maxCronExpressionLength}
              autocomplete="off"
              spellcheck={false}
              aria-describedby="schedule-cron-help schedule-cron-error"
              aria-invalid={cronTouched && Boolean(cronPreview.error)}
              onblur={() => (cronTouched = true)}
              bind:value={expression}
            />
            <p id="schedule-cron-help">{text.cronHelp}</p>
            <p id="schedule-cron-error" role="alert">
              {cronTouched ? (cronPreview.error ?? "") : ""}
            </p>
          {:else if kind !== "interval" && kind !== "webhook"}
            <label for="schedule-time">{text.time}</label>
            <TextField
              id="schedule-time"
              type="time"
              required
              aria-describedby="schedule-time-help"
              bind:value={time}
            />
            <p id="schedule-time-help">{text.dstHelp}</p>
          {:else if kind === "interval"}
            <label for="schedule-minutes">{text.minutes}</label>
            <NumberStepper
              id="schedule-minutes"
              min={data.limits.minIntervalMinutes}
              step="1"
              required
              bind:value={minutes}
              aria-describedby="schedule-interval-help"
              unit="min"
            />
            <p id="schedule-interval-help">
              {text.intervalHelp(data.limits.minIntervalMinutes)}
            </p>
          {/if}
          {#if kind === "weekly"}
            <fieldset
              class="schedule-fields"
              aria-describedby="schedule-form-error"
            >
              <legend class="py-2 font-semibold">{text.weekdays}</legend>
              <div data-ui="schedule-weekdays">
                {#each scheduleWeekdays as day, index (day)}<Checkbox
                    aria-invalid={invalid === "weekdays"}
                    value={index}
                    bind:group={weekdays}>{$messages(day)}</Checkbox
                  >{/each}
              </div>
            </fieldset>
          {/if}
          {#if kind !== "webhook"}
            <label for="schedule-zone">{text.zone}</label>
            <TextField
              id="schedule-zone"
              required
              bind:value={timeZone}
              aria-describedby="schedule-zone-help schedule-form-error"
              aria-invalid={invalid === "zone"}
            />
            <p id="schedule-zone-help">{text.zoneHelp}</p>
          {:else}<p>{text.webhookFormHelp}</p>{/if}
          {#if cronPreview.runs}
            <section aria-labelledby="schedule-cron-preview">
              <h3 id="schedule-cron-preview">{text.cronNextRuns}</h3>
              <ul>
                {#each cronPreview.runs as run (run)}
                  <li>{scheduleTimeLabel($formattingLocale, run, timeZone)}</li>
                {/each}
              </ul>
            </section>
          {/if}
          <div data-ui="schedule-actions">
            <ActionButton variant="primary" type="submit"
              >{busy
                ? text.saving
                : editId
                  ? text.save
                  : text.create}</ActionButton
            >
            <ActionButton type="button" onclick={closeForm}
              >{text.cancel}</ActionButton
            >
          </div>
        </fieldset>
      </form>
    </section>
  {/if}
  {#if data.schedules.length === 0 && !formVisible}
    <div class="panel-card"><p role="status">{text.none}</p></div>
  {/if}
  {#each data.schedules as schedule (schedule.id)}
    <section class="panel-card" aria-labelledby={`schedule-${schedule.id}`}>
      <div data-ui="schedule-heading">
        <h2 id={`schedule-${schedule.id}`}>{schedule.name}</h2>
        <span class="panel-badge"
          >{scheduleStateLabel($messages, schedule)}</span
        >
      </div>
      <p>{scheduleCadenceLabel($messages, schedule.cadence)}</p>
      <p>
        {$messages("Delivery via")}
        {channelLabel[schedule.deliveryChannel]}{linked(
          schedule.deliveryChannel,
        )
          ? ""
          : $messages(" (owner chat unlinked)")}
      </p>
      <dl>
        <dt>{text.next}</dt>
        <dd>
          {#if schedule.nextRunAt !== null}<time
              datetime={new Date(schedule.nextRunAt).toISOString()}
              >{scheduleTimeLabel(
                $formattingLocale,
                schedule.nextRunAt,
                schedule.timeZone,
              )}</time
            >{:else if schedule.cadence.kind === "webhook"}{text.webhookWaiting}{:else}{text.noNext}
            ({schedule.timeZone}){/if}
        </dd>
        <dt>{text.last}</dt>
        <dd>
          {schedule.lastRun
            ? scheduleRunLabel($messages, schedule.lastRun)
            : text.noRuns}
        </dd>
      </dl>
      <div data-ui="schedule-actions">
        <ActionButton
          disabled={busy}
          onclick={() =>
            action(schedule.id, schedule.enabled ? "pause" : "resume")}
          ><Icon
            name={schedule.enabled ? "pause" : "play"}
            size={16}
          />{schedule.enabled ? text.pause : text.resume}</ActionButton
        >
        <ActionButton disabled={busy} onclick={() => action(schedule.id, "run")}
          ><Icon name="play" size={16} />{text.run}</ActionButton
        >
        <ActionButton disabled={busy} onclick={() => openForm(schedule)}
          ><Icon name="edit" size={16} />{text.edit}</ActionButton
        >
        <ActionButton disabled={busy} onclick={() => remove(schedule)}
          ><Icon name="trash" size={16} />{text.remove}</ActionButton
        >
      </div>
      {#if schedule.cadence.kind === "webhook"}
        <ActionButton
          disabled={busy || webhookBusy}
          onclick={() => loadWebhook(schedule.id)}
          >{text.webhookShow}</ActionButton
        >
        {#if webhook?.id === schedule.id}
          <label for={`webhook-url-${schedule.id}`}>{text.webhookUrl}</label>
          <TextField
            id={`webhook-url-${schedule.id}`}
            readonly
            value={webhook.url}
          />
          <label for={`webhook-token-${schedule.id}`}>{text.webhookToken}</label
          >
          <TextField
            id={`webhook-token-${schedule.id}`}
            readonly
            value={webhook.token}
          />
          <p>{text.webhookHelp}</p>
          <div data-ui="schedule-actions">
            <ActionButton
              disabled={busy || webhookBusy}
              onclick={() => loadWebhook(schedule.id, true)}
              >{text.webhookRotate}</ActionButton
            >
            <ActionButton
              onclick={() => {
                webhook = undefined;
              }}>{text.webhookHide}</ActionButton
            >
          </div>
        {/if}
      {/if}
      {#if !schedule.enabled}<p>{text.pausedHelp}</p>{/if}
      {#if schedule.recentRuns.length > 0}
        <details>
          <summary>{text.history} ({schedule.recentRuns.length})</summary>
          <ol>
            {#each schedule.recentRuns as run (run.id)}<li>
                <time datetime={new Date(run.scheduledFor).toISOString()}
                  >{scheduleTimeLabel(
                    $formattingLocale,
                    run.scheduledFor,
                    schedule.timeZone,
                  )}</time
                ><br />{scheduleRunLabel($messages, run)}
              </li>{/each}
          </ol>
        </details>
      {/if}
    </section>
  {/each}
  <details>
    <summary class="w-fit cursor-pointer py-1"
      >{$messages("How schedules run")}</summary
    >
    <p data-ui="muted" class="mt-2">{text.rules}</p>
  </details>
  <div>
    <ActionButton href={`/agents/${encodeURIComponent(agent.id)}/setup`}
      >{text.back}</ActionButton
    >
  </div>
</div>

<style>
  [data-ui="schedules"] {
    display: grid;
    gap: 16px;
  }
  [data-ui="schedules"] :global(.panel-button) {
    border-color: var(--color-field-border);
  }
  [data-ui="schedule-actions"],
  [data-ui="schedule-heading"] {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  [data-ui="schedule-heading"] {
    justify-content: space-between;
  }
  [data-ui="schedule-heading"] h2 {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  [data-ui="schedule-warning"] {
    color: var(--color-warning);
  }
  .schedule-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    padding: 0;
    gap: 16px;
    font-size: inherit;
  }
  [data-ui="schedule-weekdays"] {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
  }
  [data-ui="schedule-weekdays"] :global(label) {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
  dl {
    grid-template-columns: minmax(0, 6rem) minmax(0, 1fr);
    gap: 8px;
  }
  summary {
    cursor: pointer;
    min-height: 44px;
    display: list-item;
    padding-block-start: 8px;
  }
  li {
    overflow-wrap: anywhere;
  }
  #schedule-form-error:not(:empty) {
    color: var(--color-error);
  }
  #schedule-form-error:empty {
    display: none;
  }
  @media (max-width: 480px) {
    dl {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
