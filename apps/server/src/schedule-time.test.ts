import { describe, expect, it } from "vitest";
import {
  MIN_SCHEDULE_INTERVAL_MINUTES,
  nextRun,
  validateCadence,
  validateTimeZone,
  type ScheduleCadence,
} from "./schedule-time.js";

const utc = Date.parse;
const next = (cadence: ScheduleCadence, zone: string, after: string) => {
  const value = nextRun(cadence, zone, utc(after));
  return value === undefined ? undefined : new Date(value).toISOString();
};

it("runs once at local time, strictly after the reference instant", () => {
  const cadence = { kind: "once", date: "2027-01-01", time: "08:30" } as const;
  expect(next(cadence, "Asia/Kolkata", "2026-12-31T23:59:00Z")).toBe(
    "2027-01-01T03:00:00.000Z",
  );
  expect(next(cadence, "Asia/Kolkata", "2027-01-01T03:00:00Z")).toBeUndefined();
  expect(next(cadence, "Asia/Kolkata", "2027-01-02T00:00:00Z")).toBeUndefined();
});

it.each([
  ["2026-01-31T09:00:00Z", "2026-02-01T09:00:00.000Z"],
  ["2028-02-28T09:00:00Z", "2028-02-29T09:00:00.000Z"],
  ["2026-12-31T09:00:00Z", "2027-01-01T09:00:00.000Z"],
  ["2026-12-31T08:59:59.999Z", "2026-12-31T09:00:00.000Z"],
])("computes daily boundaries after %s", (after, expected) => {
  expect(next({ kind: "daily", time: "09:00" }, "UTC", after)).toBe(expected);
});

it("uses the schedule's calendar date instead of the server's date", () => {
  expect(
    next(
      { kind: "daily", time: "00:15" },
      "Asia/Tokyo",
      "2026-12-31T15:30:00Z",
    ),
  ).toBe("2027-01-01T15:15:00.000Z");
  expect(
    next(
      { kind: "daily", time: "23:00" },
      "America/Argentina/Catamarca",
      "2026-12-31T01:00:00Z",
    ),
  ).toBe("2026-12-31T02:00:00.000Z");
});

it("selects the first selected weekday, including a full week later", () => {
  const cadence: ScheduleCadence = {
    kind: "weekly",
    weekdays: [1, 5],
    time: "09:00",
  };
  expect(next(cadence, "UTC", "2026-12-31T12:00:00Z")).toBe(
    "2027-01-01T09:00:00.000Z",
  );
  expect(next(cadence, "UTC", "2027-01-01T09:00:00Z")).toBe(
    "2027-01-04T09:00:00.000Z",
  );
  expect(
    next({ ...cadence, weekdays: [5] }, "UTC", "2027-01-01T09:00:00Z"),
  ).toBe("2027-01-08T09:00:00.000Z");
});

describe.each([
  {
    zone: "America/New_York",
    spring: "2027-03-14",
    fall: "2027-11-07",
    springUtc: "2027-03-14T07:00:00.000Z",
    fallUtc: "2027-11-07T05:30:00.000Z",
    repeatedUtc: "2027-11-07T06:15:00Z",
    nextDay: "2027-11-08T06:30:00.000Z",
    foldTime: "01:30",
  },
  {
    zone: "Europe/Madrid",
    spring: "2027-03-28",
    fall: "2027-10-31",
    springUtc: "2027-03-28T01:00:00.000Z",
    fallUtc: "2027-10-31T00:30:00.000Z",
    repeatedUtc: "2027-10-31T01:15:00Z",
    nextDay: "2027-11-01T01:30:00.000Z",
    foldTime: "02:30",
  },
])(
  "DST in $zone",
  ({
    zone,
    spring,
    fall,
    springUtc,
    fallUtc,
    repeatedUtc,
    nextDay,
    foldTime,
  }) => {
    it.each(["once", "daily", "weekly"] as const)(
      "moves a nonexistent %s time to the next valid instant",
      (kind) => {
        const cadence: ScheduleCadence =
          kind === "once"
            ? { kind, date: spring, time: "02:30" }
            : kind === "weekly"
              ? { kind, weekdays: [0], time: "02:30" }
              : { kind, time: "02:30" };
        expect(next(cadence, zone, `${spring}T00:00:00Z`)).toBe(springUtc);
      },
    );

    it("chooses the first occurrence of an ambiguous time", () => {
      expect(
        next(
          { kind: "once", date: fall, time: foldTime },
          zone,
          `${fall}T00:00:00Z`,
        ),
      ).toBe(fallUtc);
    });

    it("never repeats a once or daily occurrence during the repeated hour", () => {
      expect(
        next({ kind: "once", date: fall, time: foldTime }, zone, repeatedUtc),
      ).toBeUndefined();
      expect(next({ kind: "daily", time: foldTime }, zone, repeatedUtc)).toBe(
        nextDay,
      );
      const weekly = nextRun(
        { kind: "weekly", weekdays: [0], time: foldTime },
        zone,
        utc(repeatedUtc),
      );
      expect(weekly).toBe(utc(nextDay) + 6 * 86_400_000);
    });
  },
);

it("handles a half-hour DST gap and an entirely skipped local date", () => {
  expect(
    next(
      { kind: "once", date: "2027-10-03", time: "02:15" },
      "Australia/Lord_Howe",
      "2027-10-02T00:00:00Z",
    ),
  ).toBe("2027-10-02T15:30:00.000Z");
  expect(
    next(
      { kind: "once", date: "2011-12-30", time: "12:00" },
      "Pacific/Apia",
      "2011-12-29T00:00:00Z",
    ),
  ).toBe("2011-12-30T10:00:00.000Z");
});

it("anchors intervals to creation, without drift after downtime or across DST", () => {
  const cadence: ScheduleCadence = {
    kind: "interval",
    minutes: 15,
    anchor: utc("2027-03-14T06:52:12.123Z"),
  };
  expect(next(cadence, "America/New_York", "2027-03-14T06:52:12.123Z")).toBe(
    "2027-03-14T07:07:12.123Z",
  );
  expect(next(cadence, "America/New_York", "2027-03-14T07:07:12.123Z")).toBe(
    "2027-03-14T07:22:12.123Z",
  );
  expect(
    next(
      JSON.parse(JSON.stringify(cadence)) as ScheduleCadence,
      "America/New_York",
      "2027-03-18T12:08:00Z",
    ),
  ).toBe("2027-03-18T12:22:12.123Z");
  expect(next(cadence, "UTC", "2027-03-14T06:00:00Z")).toBe(
    "2027-03-14T07:07:12.123Z",
  );
});

it("validates and normalizes create/edit input", () => {
  expect(MIN_SCHEDULE_INTERVAL_MINUTES).toBe(15);
  expect(
    validateCadence(
      { kind: "weekly", weekdays: [5, 1, 1], time: "10:00" },
      "UTC",
      utc("2026-11-01T00:00:00Z"),
    ),
  ).toEqual({ kind: "weekly", weekdays: [1, 5], time: "10:00" });
  expect(() =>
    validateCadence(
      { kind: "once", date: "2028-02-29", time: "10:00" },
      "UTC",
      utc("2026-11-01T00:00:00Z"),
    ),
  ).not.toThrow();
});

it.each([
  null,
  [],
  {},
  { kind: "cron" },
  { kind: "daily", time: "24:00" },
  { kind: "daily", time: "12:60" },
  { kind: "daily", time: "9:00" },
  { kind: "daily", time: "09:00:00" },
  { kind: "daily", time: "09:00\n" },
  { kind: "daily", time: 900 },
  { kind: "weekly", time: "09:00", weekdays: [] },
  { kind: "weekly", time: "09:00", weekdays: [7] },
  { kind: "weekly", time: "09:00", weekdays: [-1] },
  { kind: "weekly", time: "09:00", weekdays: [1.5] },
  { kind: "weekly", time: "09:00", weekdays: ["1"] },
  ...["2027-02-29", "2027-04-31", "2027-13-01", "0000-01-01", "2027-1-01"].map(
    (date) => ({ kind: "once", date, time: "09:00" }),
  ),
  ...[0, -15, 14, 15.5, Infinity, NaN, Number.MAX_SAFE_INTEGER, "15"].map(
    (minutes) => ({ kind: "interval", minutes, anchor: 0 }),
  ),
  ...[undefined, NaN, Infinity, 0.5, "2027-01-01"].map((anchor) => ({
    kind: "interval",
    minutes: 15,
    anchor,
  })),
])("rejects invalid cadence %j", (cadence) => {
  expect(() =>
    validateCadence(cadence, "UTC", utc("2026-11-01T00:00:00Z")),
  ).toThrow();
});

it("requires once to be in the future when validating a mutation", () => {
  const cadence = { kind: "once", date: "2027-01-01", time: "09:00" };
  expect(() =>
    validateCadence(cadence, "UTC", utc("2027-01-01T09:00:00Z")),
  ).toThrow("future");
  expect(() =>
    validateCadence(cadence, "UTC", utc("2027-01-02T09:00:00Z")),
  ).toThrow("future");
});

it.each(["", "Not/A_Zone", "+03:00", "-0430"])(
  "rejects invalid or numeric time zone %s",
  (zone) => {
    expect(() => validateTimeZone(zone)).toThrow("IANA");
    expect(() =>
      nextRun({ kind: "interval", minutes: 15, anchor: 0 }, zone, 0),
    ).toThrow("IANA");
  },
);

it.each([NaN, Infinity, 0.5, 9e15])(
  "rejects invalid reference instant %s",
  (after) => {
    expect(() =>
      nextRun({ kind: "daily", time: "09:00" }, "UTC", after),
    ).toThrow("timestamp");
  },
);
