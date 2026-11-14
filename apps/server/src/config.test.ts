import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

const valid = {
  TELEGRAM_BOT_TOKEN: "123:fake_test_token",
  TELEGRAM_ALLOWED_USER_IDS: "42, 73,42",
};

describe("server configuration", () => {
  it("parses and deduplicates the allowlist", () => {
    expect([...readConfig(valid).allowedUserIds]).toEqual([42, 73]);
  });
  it.each([
    undefined,
    "",
    "42,",
    "0",
    "-1",
    "1.5",
    "1e3",
    "9007199254740992",
    "all",
  ])("rejects invalid allowlist %s", (value) => {
    expect(() =>
      readConfig({ ...valid, TELEGRAM_ALLOWED_USER_IDS: value }),
    ).toThrow("TELEGRAM_ALLOWED_USER_IDS");
  });
  it.each([undefined, "", "secret-value"])(
    "rejects an invalid token without exposing it",
    (value) => {
      expect(() => readConfig({ ...valid, TELEGRAM_BOT_TOKEN: value })).toThrow(
        "TELEGRAM_BOT_TOKEN must contain a valid Telegram bot token.",
      );
    },
  );
});
