/** Local times have minute precision; weekdays use Sunday = 0 through Saturday = 6. */
export type ScheduleCadence =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; weekdays: number[]; time: string }
  | { kind: "interval"; minutes: number; anchor: number };

export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

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
  if (nextRun(cadence, timeZone, now) === undefined) {
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
