import { expect, it } from "vitest";
import { findLegacySettings } from "./legacy-settings.js";

it("reports only the names of legacy settings that are set", () => {
  expect(findLegacySettings({})).toEqual([]);
  expect(
    findLegacySettings({
      TELEGRAM_BOT_TOKEN: "123456:secret-token-value",
      TELEGRAM_ALLOWED_USER_IDS: "  ",
      AGENT_NAME: "Agent",
      PANEL_PASSWORD_HASH: "scrypt:a:b",
    }),
  ).toEqual(["TELEGRAM_BOT_TOKEN", "AGENT_NAME"]);
});
