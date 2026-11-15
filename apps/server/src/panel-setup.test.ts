import { expect, it } from "vitest";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { parseAllowedUsers } from "./telegram-access.js";

it("protects initial setup and lets the administrator configure access on an empty installation", async () => {
  let users: number[] = [];
  const app = createPanel(
    readPanelConfig({
      PANEL_PASSWORD_HASH: await hashPassword("test-setup-password"),
    }),
    () => ({ telegram: "disconnected" }),
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => [],
    undefined,
    {
      get: () => users,
      save: (text) => {
        users = [...parseAllowedUsers(text)];
      },
    },
  );
  const post = (
    path: string,
    body: string,
    cookie = "",
    origin = "http://localhost:3000",
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  expect((await post("/settings/telegram", "users=42")).status).toBe(303);
  expect(users).toEqual([]);
  const login = await post("/login", "password=test-setup-password");
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const home = await (
    await app.request("/", { headers: { Cookie: cookie } })
  ).text();
  expect(home).toContain("No agents yet");
  expect(home).not.toContain("Configured agent");
  expect(home).toContain("Telegram access");
  expect(
    (
      await post(
        "/settings/telegram",
        "users=42",
        cookie,
        "https://forged.example",
      )
    ).status,
  ).toBe(403);
  expect(users).toEqual([]);
  expect(
    (await post("/settings/telegram", "users=42%2C73", cookie)).status,
  ).toBe(303);
  expect(users).toEqual([42, 73]);
  expect((await post("/settings/telegram", "users=bad", cookie)).status).toBe(
    400,
  );
  expect(users).toEqual([42, 73]);
  expect((await post("/settings/telegram", "users=", cookie)).status).toBe(303);
  expect(users).toEqual([]);
});
