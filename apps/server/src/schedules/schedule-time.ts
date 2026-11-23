/** Local times have minute precision; weekdays use Sunday = 0 through Saturday = 6. */
export type ScheduleCadence =
  | { kind: "webhook" }
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; weekdays: number[]; time: string }
  | { kind: "interval"; minutes: number; anchor: number }
  | { kind: "cron"; expression: string };

export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;
export const MAX_CRON_EXPRESSION_LENGTH = 100;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const cronMacros = new Map([
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
  ["@monthly", "0 0 1 * *"],
  ["@weekly", "0 0 * * 0"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@hourly", "0 * * * *"],
]);
const cronMonths = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(" ");
const cronWeekdays = "SUN MON TUE WED THU FRI SAT".split(" ");

type CronField = "minute" | "hour" | "day of month" | "month" | "day of week";

export type CronErrorDetails =
  | { code: "cron_too_long"; params: [max: number] }
  | {
      code: "cron_invalid_value" | "cron_invalid_item";
      params: [field: CronField, value: string];
    }
  | {
      code: "cron_value_outside_range";
      params: [field: CronField, value: string, min: number, max: number];
    }
  | {
      code:
        | "cron_step_requires_range"
        | "cron_invalid_step"
        | "cron_reversed_range";
      params: [field: CronField];
    };

export class CronValidationError extends Error {
  constructor(
    message: string,
    readonly details: CronErrorDetails,
  ) {
    super(message);
  }
}

function parseCronField(
  field: string,
  name: CronField,
  min: number,
  max: number,
  names: string[] = [],
): number[] {
  const error = (message: string, details: CronErrorDetails) =>
    new CronValidationError(`Cron ${name} field: ${message}`, details);
  const parseValue = (token: string) => {
    const index = names.indexOf(token);
    if (index >= 0) return index + min;
    if (!/^\d+$/.test(token))
      throw error(`Invalid value "${token}".`, {
        code: "cron_invalid_value",
        params: [name, token],
      });
    const value = Number(token);
    if (value < min || value > max)
      throw error(`${token} is outside ${min}-${max}.`, {
        code: "cron_value_outside_range",
        params: [name, token, min, max],
      });
    return value;
  };
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const match = /^(\*|[A-Z0-9]+)(?:-([A-Z0-9]+))?(?:\/(\d+))?$/.exec(item);
    if (!match || (match[1] === "*" && match[2]))
      throw error(`Invalid item "${item}".`, {
        code: "cron_invalid_item",
        params: [name, item],
      });
    const [, start, end, stride] = match;
    if (stride !== undefined && start !== "*" && end === undefined)
      throw error("Steps require a range or *.", {
        code: "cron_step_requires_range",
        params: [name],
      });
    const step = stride === undefined ? 1 : Number(stride);
    if (!Number.isSafeInteger(step) || step < 1)
      throw error("Step must be a positive whole number.", {
        code: "cron_invalid_step",
        params: [name],
      });
    const first = start === "*" ? min : parseValue(start!);
    const last = start === "*" ? max : end ? parseValue(end) : first;
    if (last < first)
      throw error("Range must start at or before its end.", {
        code: "cron_reversed_range",
        params: [name],
      });
    for (let value = first; value <= last; value += step)
      values.add(name === "day of week" && value === 7 ? 0 : value);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCronExpression(input: string) {
  if (input.length > MAX_CRON_EXPRESSION_LENGTH)
    throw new CronValidationError(
      `Cron expression must be at most ${MAX_CRON_EXPRESSION_LENGTH} characters.`,
      { code: "cron_too_long", params: [MAX_CRON_EXPRESSION_LENGTH] },
    );
  const normalized = input.trim().replace(/\s+/g, " ").toUpperCase();
  const macro = normalized.toLowerCase();
  const expanded = cronMacros.get(macro);
  const expression = expanded ? macro : normalized;
  const fields = (expanded ?? expression).split(" ");
  if (fields.length !== 5)
    throw new Error(
      "Cron expression must have five fields or use a supported macro.",
    );
  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseCronField(minute, "minute", 0, 59);
  const hours = parseCronField(hour, "hour", 0, 23);
  const daysOfMonth = parseCronField(dom, "day of month", 1, 31);
  const months = parseCronField(month, "month", 1, 12, cronMonths);
  const daysOfWeek = parseCronField(dow, "day of week", 0, 7, cronWeekdays);
  if (
    minutes.some(
      (value, index) =>
        (minutes[index + 1] ?? minutes[0]! + 60) - value <
        MIN_SCHEDULE_INTERVAL_MINUTES,
    )
  ) {
    throw new Error("Cron minutes must be at least 15 minutes apart.");
  }
  return {
    expression,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

function formatter(timeZone: string) {
  // Intl also accepts numeric offsets on newer Node versions. Schedules require
  // named zones, so their daylight-saving rules survive a server restart.
  if (typeof timeZone !== "string" || /^[+-]/.test(timeZone)) {
    throw new Error("Time zone must be a valid IANA time zone name.");
  }
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("Time zone must be a valid IANA time zone name.");
  }
}

export function validateTimeZone(timeZone: string): void {
  formatter(timeZone);
}

function validInstant(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function parseCadence(input: unknown): ScheduleCadence {
  if (!input || typeof input !== "object") {
    throw new Error("Cadence must be an object.");
  }
  const value = input as Record<string, unknown>;
  if (value.kind === "cron") {
    if (typeof value.expression !== "string")
      throw new Error("Cron expression must be text.");
    return {
      kind: "cron",
      expression: parseCronExpression(value.expression).expression,
    };
  }
  if (value.kind === "webhook") return { kind: "webhook" };
  if (value.kind === "interval") {
    if (
      typeof value.minutes !== "number" ||
      !Number.isSafeInteger(value.minutes) ||
      value.minutes < MIN_SCHEDULE_INTERVAL_MINUTES ||
      !Number.isSafeInteger(value.minutes * MINUTE)
    ) {
      throw new Error(
        "Interval must be a whole number of at least 15 minutes.",
      );
    }
    if (!validInstant(value.anchor)) {
      throw new Error("Interval anchor must be a valid UTC timestamp.");
    }
    return { kind: "interval", minutes: value.minutes, anchor: value.anchor };
  }
  if (
    value.kind !== "once" &&
    value.kind !== "daily" &&
    value.kind !== "weekly"
  ) {
    throw new Error("Unknown schedule cadence kind.");
  }
  if (
    typeof value.time !== "string" ||
    value.time.length !== 5 ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
  ) {
    throw new Error("Time must use HH:mm in the range 00:00 to 23:59.");
  }
  if (value.kind === "once") {
    if (
      typeof value.date !== "string" ||
      value.date.length !== 10 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
      value.date.startsWith("0000") ||
      !Number.isFinite(Date.parse(`${value.date}T00:00:00Z`)) ||
      new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) !==
        value.date
    ) {
      throw new Error(
        "Date must be a valid calendar date in YYYY-MM-DD format.",
      );
    }
    return { kind: "once", date: value.date, time: value.time };
  }
  if (value.kind === "weekly") {
    if (
      !Array.isArray(value.weekdays) ||
      value.weekdays.length === 0 ||
      value.weekdays.some(
        (day: unknown) =>
          typeof day !== "number" ||
          !Number.isInteger(day) ||
          day < 0 ||
          day > 6,
      )
    ) {
      throw new Error(
        "Select at least one weekday (Sunday = 0 to Saturday = 6).",
      );
    }
    return {
      kind: "weekly",
      time: value.time,
      weekdays: [...new Set(value.weekdays as number[])].sort(),
    };
  }
  return { kind: "daily", time: value.time };
}

/** Validate untrusted create/edit input, including a future occurrence for once. */
export function validateCadence(
  input: unknown,
  timeZone: string,
  now: number,
): ScheduleCadence {
  const cadence = parseCadence(input);
  validateTimeZone(timeZone);
  if (
    cadence.kind !== "webhook" &&
    nextRun(cadence, timeZone, now) === undefined
  ) {
    throw new Error("Schedule must have an occurrence in the future.");
  }
  return cadence;
}

function localMinute(format: Intl.DateTimeFormat, instant: number): number {
  const parts = Object.fromEntries(
    format.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return Date.parse(
    `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`,
  );
}

function resolveLocal(format: Intl.DateTimeFormat, target: number): number {
  // Try the nearby offsets first so ordinary schedules need only a few Intl
  // conversions. Checking both sides of a transition also finds both candidates
  // in a repeated hour; the earlier UTC candidate wins.
  const candidates = new Set<number>();
  for (const delta of [-2 * DAY, 0, 2 * DAY]) {
    const probe = target + delta;
    const offset = localMinute(format, probe) - probe;
    const candidate = target - offset;
    if (localMinute(format, candidate) === target) candidates.add(candidate);
  }
  if (candidates.size > 0) return Math.min(...candidates);

  // Search UTC in chronological order. This chooses the first occurrence of an
  // ambiguous minute and the first valid minute after a gap (even a skipped day).
  // All IANA offsets fit inside this window. Keeping the conversion explicit
  // avoids relying on the server's own time zone or Date's DST disambiguation.
  for (
    let utc = target - 26 * 60 * MINUTE;
    utc <= target + 26 * 60 * MINUTE;
    utc += MINUTE
  ) {
    if (localMinute(format, utc) >= target) return utc;
  }
  throw new Error("Unable to resolve schedule local time.");
}

function nextCronRun(
  cron: ReturnType<typeof parseCronExpression>,
  format: Intl.DateTimeFormat,
  after: number,
): number | undefined {
  const local = localMinute(format, after);
  const firstDay = Math.floor(local / DAY) * DAY;
  // Eight years covers the gap between leap days at non-leap centuries.
  for (let offset = 0; offset <= 8 * 366; offset++) {
    const day = firstDay + offset * DAY;
    const date = new Date(day);
    if (!cron.months.includes(date.getUTCMonth() + 1)) continue;
    const domMatches = cron.daysOfMonth.includes(date.getUTCDate());
    const dowMatches = cron.daysOfWeek.includes(date.getUTCDay());
    const dayMatches =
      cron.domRestricted && cron.dowRestricted
        ? domMatches || dowMatches
        : domMatches && dowMatches;
    if (!dayMatches) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const target = day + (hour * 60 + minute) * MINUTE;
        if (target <= local) continue;
        const occurrence = resolveLocal(format, target);
        if (occurrence > after) return occurrence;
      }
    }
  }
}

/** Return a UTC timestamp strictly after `after`, or undefined when finished. */
export function nextRun(
  input: ScheduleCadence,
  timeZone: string,
  after: number,
): number | undefined {
  if (!validInstant(after))
    throw new Error("After must be a valid UTC timestamp.");
  const cadence = parseCadence(input);
  const format = formatter(timeZone);
  if (cadence.kind === "webhook") return undefined;
  if (cadence.kind === "interval") {
    const step = cadence.minutes * MINUTE;
    const occurrence =
      cadence.anchor +
      Math.max(1, Math.floor((after - cadence.anchor) / step) + 1) * step;
    return validInstant(occurrence) ? occurrence : undefined;
  }
  if (cadence.kind === "once") {
    const occurrence = resolveLocal(
      format,
      Date.parse(`${cadence.date}T${cadence.time}:00Z`),
    );
    return occurrence > after ? occurrence : undefined;
  }
  if (cadence.kind === "cron")
    return nextCronRun(parseCronExpression(cadence.expression), format, after);
  const local = localMinute(format, after);
  const date = Math.floor(local / DAY) * DAY;
  const [hour, minute] = cadence.time.split(":").map(Number) as [
    number,
    number,
  ];
  for (let offset = 0; offset <= 7; offset++) {
    const day = date + offset * DAY;
    if (
      cadence.kind === "weekly" &&
      !cadence.weekdays.includes(new Date(day).getUTCDay())
    ) {
      continue;
    }
    const occurrence = resolveLocal(
      format,
      day + (hour * 60 + minute) * MINUTE,
    );
    if (occurrence > after) return occurrence;
  }
  throw new Error("Unable to find the next schedule occurrence.");
}

export function nextRuns(
  cadence: ScheduleCadence,
  timeZone: string,
  after: number,
  count: number,
): number[] {
  const runs: number[] = [];
  for (let index = 0; index < Math.min(5, Math.floor(count)); index++) {
    const run = nextRun(cadence, timeZone, after);
    if (run === undefined) break;
    runs.push(run);
    after = run;
  }
  return runs;
}
