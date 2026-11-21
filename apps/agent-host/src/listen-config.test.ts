import { describe, expect, it } from "vitest";
import { readListenConfig } from "./listen-config.js";

describe("Agent Host listener configuration", () => {
  it("preserves the existing container endpoint when unset", () => {
    expect(readListenConfig({})).toEqual({ hostname: "0.0.0.0", port: 3001 });
  });

  it.each(["127.0.0.1", "::1"])(
    "accepts loopback address %s and a separate port",
    (hostname) => {
      expect(
        readListenConfig({
          AGENT_HOST_BIND_ADDRESS: hostname,
          AGENT_HOST_PORT: "41001",
        }),
      ).toEqual({ hostname, port: 41001 });
    },
  );

  it.each(["1", "65535"])("accepts boundary port %s", (port) => {
    expect(readListenConfig({ AGENT_HOST_PORT: port }).port).toBe(Number(port));
  });

  it.each([
    "",
    "0",
    "65536",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "1e3",
    " 3001",
    "3001x",
  ])("rejects invalid port %j", (port) => {
    expect(() => readListenConfig({ AGENT_HOST_PORT: port })).toThrow(
      "AGENT_HOST_PORT",
    );
  });

  it.each([
    "",
    "localhost",
    "http://127.0.0.1",
    "127.0.0.1:3001",
    "[::1]",
    " 127.0.0.1",
  ])("rejects invalid bind address %j", (hostname) => {
    expect(() =>
      readListenConfig({ AGENT_HOST_BIND_ADDRESS: hostname }),
    ).toThrow("AGENT_HOST_BIND_ADDRESS");
  });
});
