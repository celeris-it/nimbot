import { expect, it } from "vitest";
import { resolve } from "node:path";
import { readServerMode } from "./server-mode.js";
const panel = {
  hostname: "127.0.0.1",
  port: 3000,
  origin: "http://localhost:3000",
  passwordHash: "unused",
};
it("keeps Docker mode and allocates native state separately by default", () => {
  expect(readServerMode({}, panel)).toEqual({
    mode: "docker",
    stateDirectory: resolve(".nimbot"),
  });
  expect(readServerMode({ NIMBOT_MODE: "native" }, panel)).toEqual({
    mode: "native",
    stateDirectory: resolve(".nimbot-native"),
  });
  expect(
    readServerMode(
      { NIMBOT_MODE: "native", SERVER_STATE_DIR: "/tmp/custom" },
      panel,
    ).stateDirectory,
  ).toBe("/tmp/custom");
});
it.each(["0.0.0.0", "::", "192.0.2.1"])(
  "rejects externally bound native development on %s",
  (hostname) => {
    expect(() =>
      readServerMode({ NIMBOT_MODE: "native" }, { ...panel, hostname }),
    ).toThrow("loopback");
  },
);
it.each(["127.0.0.1", "::1", "localhost"])(
  "accepts native loopback %s",
  (hostname) => {
    expect(
      readServerMode({ NIMBOT_MODE: "native" }, { ...panel, hostname }).mode,
    ).toBe("native");
  },
);
it("rejects unknown modes", () => {
  expect(() => readServerMode({ NIMBOT_MODE: "other" }, panel)).toThrow(
    "NIMBOT_MODE",
  );
});
