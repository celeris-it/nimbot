/** Structured JSON-line logging with secrets removed. Keep in step with apps/agent-host/src/logger.ts. */
export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | undefined>;
export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Same sink, with these fields added to every entry (for example `agentId`). */
  child(fields: LogFields): Logger;
}

const SECRET_KEY = /token|password|secret|authorization|credential|cookie/i;
const PATTERNS: [RegExp, string][] = [
  [/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [/\b[a-f0-9]{64}\b/gi, "[redacted]"],
  [/\bscrypt\$[^\s"']+/g, "[redacted]"],
];

export function redact(text: string): string {
  return PATTERNS.reduce(
    (out, [pattern, to]) => out.replace(pattern, to),
    text,
  );
}

/** `sink` receives one JSON line per entry; the default writes to the console. */
export function createLogger(
  sink: (level: LogLevel, line: string) => void = (level, line) =>
    process.env.NIMBOT_LOG === "silent"
      ? undefined
      : level === "info"
        ? console.log(line)
        : console.error(line),
  base: LogFields = {},
  now: () => Date = () => new Date(),
): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const entry: Record<string, unknown> = {
      time: now().toISOString(),
      level,
      event: redact(event).slice(0, 200),
    };
    for (const [key, value] of Object.entries({ ...base, ...fields })) {
      if (value === undefined) continue;
      entry[key] = SECRET_KEY.test(key)
        ? "[redacted]"
        : typeof value === "string"
          ? redact(value).slice(0, 500)
          : value;
    }
    sink(level, JSON.stringify(entry));
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger(sink, { ...base, ...fields }, now),
  };
}

/** Process-wide logger. Silenced with NIMBOT_LOG=silent (used by the test suite). */
export const log = createLogger();
