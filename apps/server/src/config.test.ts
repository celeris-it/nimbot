import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

const valid = {
  TELEGRAM_BOT_TOKEN: "123:fake_test_token",
  TELEGRAM_ALLOWED_USER_IDS: "42, 73,42",
  TELEGRAM_OWNER_USER_ID: "42",
};

describe("server configuration", () => {
  it("parses and deduplicates the allowlist", () => {
    expect([...readConfig(valid).allowedUserIds]).toEqual([42, 73]);
  });
  it("infers the owner only for a single allowed user", () => {
    expect(
      readConfig({
        ...valid,
        TELEGRAM_ALLOWED_USER_IDS: "42",
        TELEGRAM_OWNER_USER_ID: undefined,
      }).agent.ownerId,
    ).toBe(42);
    expect(() =>
      readConfig({ ...valid, TELEGRAM_OWNER_USER_ID: undefined }),
    ).toThrow("TELEGRAM_OWNER_USER_ID");
  });
  it.each(["99", "1e2", "-1", "0", "42.0"])(
    "rejects invalid or non-allowlisted owner %s",
    (owner) => {
      expect(() =>
        readConfig({ ...valid, TELEGRAM_OWNER_USER_ID: owner }),
      ).toThrow("TELEGRAM_OWNER_USER_ID");
    },
  );
  it("validates agent identity", () => {
    expect(
      readConfig({ ...valid, AGENT_ID: "dev", AGENT_NAME: "Developer" }).agent
        .name,
    ).toBe("Developer");
    expect(() => readConfig({ ...valid, AGENT_ID: "../bad" })).toThrow(
      "AGENT_ID",
    );
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
