# Scheduled tasks

Open **Schedules** on an agent's page to create, edit, pause, resume, run,
or delete saved prompts. The panel shows each schedule's next local run time,
enabled state, delivery channel, and recent run outcomes. `/schedules` lists
schedules in the owner's Telegram chat or Discord DM even if the Host is
stopped. Edit **Delivery channel** to route future runs to a different linked
owner chat. Existing schedules and new panel schedules default to Telegram.

To create a timed schedule in Telegram or Discord, message your agent as usual, for example
“Remind me every Monday at 9 AM to review invoices.” The agent asks for any
missing details. Review the task, cadence, time zone, and first run, then choose
**Confirm** to save it or **Cancel** to discard it. A newer preview replaces the
previous one, and previews expire after ten minutes or on server restart.
The schedule delivers to the channel where you confirmed it.

Set the installation's **Schedule time zone** in the panel under **Settings**.
It starts at `UTC`, applies to new schedules created in chat, and prefills
the editable time zone for new schedules in the panel. Saved schedules retain
their own time zone.

## Cadences and limits

| Cadence | Timing |
|---|---|
| Once | One local date and time; disabled after its due occurrence is handled, including a skipped or missed run |
| Daily | The same local time each day |
| Weekly | The same local time on one or more selected weekdays |
| Interval | Every N minutes, anchored to creation time across pauses, edits, and restarts |
| Cron | A five-field cron expression evaluated in the schedule time zone |
| Webhook | On an authenticated POST request; no timed occurrence |

Limits are 20 schedules per agent, an interval of at least 15 minutes, a name of
up to 60 characters, and a prompt of up to 4000 characters. A local time skipped
by daylight saving runs at the next valid instant; a repeated time runs only at
its first occurrence. Intervals use elapsed minutes. These are fixed rules, with
no scheduler-specific environment variables.

Cron expressions accept up to 100 characters. The fields are minute (0–59),
hour (0–23), day of month (1–31), month (1–12), and day of week (0–7, with
Sunday as 0 or 7). Use `*`, values, ranges, comma-separated lists, or steps on
wildcards and ranges. Month names `JAN`–`DEC` and weekday names `SUN`–`SAT`
are case-insensitive. The supported shortcuts are `@yearly`, `@annually`,
`@monthly`, `@weekly`, `@daily`, `@midnight`, and `@hourly`. When both day
fields are restricted, either one can match. The minute values must be at least
15 minutes apart, including the gap across the hour boundary. Cron follows the
daylight-saving rules above, and runs that fall into the same skipped interval
collapse to one run at the next valid instant. The panel previews up to five
runs and chat confirmations show the first and up to three more.

## Panel API

The same operations are available under the authenticated
`/api/agents/:id/schedules` API. Mutations use POST. Schedule settings are form
fields `name`, `prompt`, `timeZone`, and `cadence` (a JSON object with its kind and
matching fields). The optional `deliveryChannel` field accepts `telegram` or
`discord`. Omitting it on edit preserves the saved channel. The server assigns
interval anchors. For a weekday schedule at 9 a.m., send
`cadence={"kind":"cron","expression":"0 9 * * 1-5"}`.
Read or change the global zone with `GET` or `POST /api/settings/schedules`.
The POST accepts the `timeZone` form field.

## Execution and delivery

The scheduler runs inside the Nimbot Server, once at startup and every 30 seconds.
It records each occurrence, enqueues its task, and advances the next run in one
SQLite transaction. A repeated tick or server restart cannot enqueue the same
timed occurrence twice. A saved due occurrence up to 10 minutes late is considered
once; older occurrences are recorded as `missed`. The next run advances past the
current server time, without replaying a backlog. A previous task from the same
schedule still queued or running produces `skipped_overlap`. A stopped or
unavailable Host, incomplete setup, or unlinked owner chat produces
`skipped_not_ready`. Schedules never start stopped Hosts automatically. The server attempts a
durable notification only for the first not-ready skip of a consecutive streak.

Each executed run uses the agent's AI provider credits and shares its existing conversation
context and FIFO queue with chat messages. Only the final result or failure is
sent, prefixed with the schedule name saved at enqueue time. Scheduled runs do
not show a typing indicator. Results, approvals, and `/stop` use the linked owner chat
saved when the run was queued. A new destination applies to future runs.

## Manual runs and schedule changes

**Run now** uses the same readiness and overlap checks and records its outcome
without changing the next timed occurrence. A paused schedule can still be run
manually. Resume recomputes the first future occurrence; an expired once schedule
needs a future date before it can resume. Deleting a schedule removes its run
history and stops future runs; already queued or running tasks are kept.
Deleting an agent removes its schedules and run history while preserving agent data
unless data deletion was explicitly requested.

## Webhook activation

Choose **Webhook** in the schedule's **Activation** field and save. Open **Show
webhook details** to get its URL and private Bearer token. The URL uses the
configured `PANEL_URL`; external callers need to reach that origin. Use HTTPS
when exposing it outside localhost. Tokens are stored in the server database,
excluded from schedule listings, and visible only through the authenticated
panel API. **Regenerate token** immediately revokes the previous token. Changing
to a timed activation or deleting the schedule also revokes webhook access.

```sh
curl -X POST 'https://nimbot.example.com/hooks/schedules/SCHEDULE_ID' \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"event":"deployment","environment":"production"}'
```

An empty body runs the saved prompt. An optional JSON body of up to 16 KiB is
appended as external data to the task prompt and persisted with the task. It
cannot override the saved prompt or delivery target. Cookies and panel login
are not used for this endpoint. Requests return `202` once the task is durably
queued, `401` for invalid credentials, `400` for invalid JSON, `413` for an
oversized body, or `415` for an unsupported content type. A paused, changed,
or not-ready schedule returns `409`; an unavailable scheduler returns `503`.
Responses contain only an `outcome` and, on failure, an `error` message.
Results and approvals use the schedule's selected owner chat.

A request that arrives while an earlier run of the same schedule is still
queued or running is not skipped: it becomes its own task, with its own
payload, in the agent's durable FIFO queue, and runs in arrival order. One
webhook schedule can hold up to 20 unfinished tasks; further requests return
`429` until the backlog drains. Timed occurrences and **Run now** keep the
overlap skip. A stopped or not-ready agent queues nothing and returns `409`.

Webhook admission is limited to five attempts per rolling minute. Recent
skipped and manual runs count toward this limit; additional requests return `429` with
`Retry-After: 60` before the Host is contacted. The limit survives server
restarts. Pausing blocks webhooks; **Run now** still works while paused.
Admission rechecks the enabled state, settings, token, and backlog before
persisting work. Webhook invocations do not have automatic retries or event
deduplication: a repeated request creates another task. External callers
should avoid blindly retrying uncertain deliveries. Webhooks never start stopped Hosts
automatically.

The authenticated API exposes `GET /api/agents/:id/schedules/:scheduleId/webhook`
and `POST /api/agents/:id/schedules/:scheduleId/webhook/rotate` to read or
regenerate `{url, token}`. Create or edit with `cadence={"kind":"webhook"}` and
`timeZone=UTC`, alongside the usual name and prompt form fields.

For skipped runs and delivery issues, see [schedule troubleshooting](OPERATIONS.md#scheduled-tasks).
