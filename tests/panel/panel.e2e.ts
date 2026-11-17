import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Administrator password").fill("panel-test-password");
  await page.getByRole("button", { name: "Sign in to the panel" }).click();
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test("manages global API keys with keyboard navigation, blank secret fields and accessible errors", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "AI providers", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/providers$/);
  const openai = page.getByRole("region", { name: "OpenAI", exact: true });
  const key = page.getByLabel("OpenAI API key", { exact: true });
  await expect(
    openai.getByText("Not configured", { exact: true }),
  ).toBeVisible();
  await key.fill("private-first");
  await page.keyboard.press("Tab");
  await expect(
    openai.getByRole("button", { name: "Save API key" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(openai.getByText("Configured", { exact: true })).toBeVisible();
  await expect(key).toHaveValue("");
  await key.fill("private-replacement");
  await openai.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByRole("status")).toContainText("API key saved.");
  await expect(key).toHaveValue("");
  await page.reload();
  await expect(openai.getByText("Configured", { exact: true })).toBeVisible();
  await expect(key).toHaveValue("");
  await key.fill("invalid key");
  await openai.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByRole("alert")).toContainText("without whitespace");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(key).toHaveValue("");
  await expect(openai.getByText("Configured", { exact: true })).toBeVisible();
  await openai.getByRole("button", { name: "Remove API key" }).click();
  await expect(
    openai.getByText("Not configured", { exact: true }),
  ).toBeVisible();
  await expect(
    openai.getByRole("button", { name: "Remove API key" }),
  ).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("private-first");
  await expect(page.locator("main")).not.toContainText("private-replacement");
  await page.goto("/agents/dev/setup");
  await page
    .getByRole("link", { name: "Configure global AI providers" })
    .click();
  await expect(
    page.getByRole("heading", { name: "AI providers", exact: true }),
  ).toBeVisible();
});

test("logs in, follows deep links and browser history, and signs out", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to/.test(message.text())
    )
      violations.push(message.text());
  });
  await login(page);
  await page.getByRole("link", { name: "Manage" }).click();
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Edit agent", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Developer",
  );
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Edit agent." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(violations).toEqual([]);
});

test("preserves nonsecret creation fields on failure, clears the token and cancels setup", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "Create agent", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Researcher");
  await page.getByLabel("Instructions (optional)").fill("Be concise");
  await page.getByLabel("Owner's Telegram ID").fill("42");
  await page.getByLabel("Telegram bot token").fill("wrong-token");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not register");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Researcher",
  );
  await expect(page.getByLabel("Owner's Telegram ID")).toHaveValue("42");
  await expect(page.getByLabel("Telegram bot token")).toHaveValue("");
  await page.getByLabel("Telegram bot token").fill("valid-token");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(/\/agents\/created\/setup$/);
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(
    page.getByText("Cancellation requested; waiting", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel setup" })).toHaveCount(
    0,
  );
});

test("saves edits without document navigation and does not overwrite a draft", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/settings");
  await page.getByLabel("Name", { exact: true }).fill("Edited developer");
  await page.waitForTimeout(5200);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Edited developer",
  );
  let documents = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest()) documents++;
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toHaveText("Changes saved.");
  expect(documents).toBe(0);
  await page.getByRole("link", { name: "Back to agent" }).click();
  await expect(
    page.getByRole("heading", { name: "Edited developer", exact: true }),
  ).toBeVisible();
});

test("replaces a token, starts and confirms stopping a container", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/token");
  await page.getByLabel("New Telegram token").fill("valid-token");
  await page.getByRole("button", { name: "Save token" }).click();
  await expect(page.getByRole("status")).toContainText("restart the server");
  await expect(page.getByLabel("New Telegram token")).toHaveValue("");
  await page.getByRole("link", { name: "Back to agent" }).click();
  await expect(
    page.getByRole("heading", { name: "Container stopped." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start container" }).click();
  await expect(
    page.getByRole("heading", { name: "Container available." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Stop container…" }).click();
  await expect(
    page.getByRole("heading", { name: "Stop Developer?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm stop" }).click();
  await expect(
    page.getByRole("heading", { name: "Container stopped." }),
  ).toBeVisible();
  await expect(
    page.getByText("Task interrupted.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("private-task-id");
});

for (const deleteData of [false, true])
  test(`deletes with explicit confirmation and deleteData=${deleteData}`, async ({
    page,
  }) => {
    await login(page);
    await page.goto("/agents/dev/delete");
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(
      page.getByText("This does not delete the bot", { exact: false }),
    ).toBeVisible();
    if (deleteData) await page.getByRole("checkbox").check();
    const sent = page.waitForRequest((request) =>
      request.url().endsWith("/api/agents/dev/delete"),
    );
    await page.getByRole("button", { name: "Confirm deletion" }).click();
    expect(
      new URLSearchParams((await sent).postData()!).get("deleteData"),
    ).toBe(String(deleteData));
    await expect(
      page.getByText("No agents yet. Create your first agent."),
    ).toBeVisible();
  });

test("preserves last state on polling errors and handles expiry", async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto("/agents/dev/setup");
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  let calls = 0;
  await page.route("**/api/agents/dev", async (route) => {
    calls++;
    if (calls === 1)
      await route.fulfill({ status: 503, json: { error: "Offline" } });
    else await route.continue();
  });
  await expect(
    page.getByText("Could not update the status.", { exact: false }),
  ).toBeVisible({ timeout: 8000 });
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh status" }).last().click();
  await expect(
    page.getByText("Could not update the status.", { exact: false }),
  ).toHaveCount(0);
  await context.clearCookies();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("blocks duplicate submissions and treats an uncertain mutation as an error", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/settings");
  await page.getByLabel("Name", { exact: true }).fill("Draft");
  let calls = 0;
  await page.route("**/api/agents/dev/settings", async (route) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.abort();
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "Refresh the status before retrying",
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Draft");
  expect(calls).toBe(1);
});

test("shows a missing agent after a refresh", async ({ page }) => {
  await login(page);
  await page.goto("/agents/dev/setup");
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  await page.request.post("/api/agents/dev/delete", {
    form: { confirm: "dev", deleteData: "false" },
    headers: { Origin: "http://127.0.0.1:3199" },
  });
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(
    page.getByRole("heading", { name: "Page not found." }),
  ).toBeVisible();
});

test("supports keyboard navigation and narrow screens", async ({ page }) => {
  await page.goto("/login");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to main content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByLabel("Administrator password").fill("panel-test-password");
  await page.getByLabel("Administrator password").press("Enter");
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeVisible();
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: "test-results/panel-desktop.png",
    fullPage: true,
  });
});

test("does not overlap polls, pauses while hidden and cancels obsolete requests", async ({
  page,
}) => {
  await page.clock.install();
  await login(page);
  await page.goto("/agents/dev/setup");
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  let calls = 0;
  let release: (() => void) | undefined;
  await page.route("**/api/agents/dev", async (route) => {
    calls++;
    if (calls === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.continue();
  });
  await page.clock.runFor(5000);
  await expect.poll(() => calls).toBe(1);
  await page.clock.runFor(10000);
  expect(calls).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  release!();
  await page.clock.runFor(15000);
  expect(calls).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => calls).toBe(2);
  await page.getByRole("link", { name: "Edit agent", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Developer",
  );
  await page.clock.runFor(10000);
  expect(calls).toBe(3);
});

test("shows a load failure without suggesting that the installation has zero agents", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 503, json: { error: "Offline" } }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Status unavailable." }),
  ).toBeVisible();
  await expect(page.getByText("No agents yet.", { exact: false })).toHaveCount(
    0,
  );
});

test("keeps forms within mobile widths and retains readable theme contrast", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/settings");
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  const ratios = await page.evaluate(() => {
    function rgb(color: string) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    }
    function luminance(color: string) {
      const linear = rgb(color).map((channel) => {
        const s = channel / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    }
    function ratio(first: string, second: string) {
      const a = luminance(first),
        b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    return ["body", ".card", "button.btn", ".input"].map((selector) => {
      const element = document.querySelector(selector)!;
      const style = getComputedStyle(element);
      return {
        selector,
        text: ratio(style.color, style.backgroundColor),
        border:
          selector === ".input"
            ? ratio(style.borderColor, style.backgroundColor)
            : undefined,
      };
    });
  });
  for (const item of ratios) {
    expect(item.text, `${item.selector} text contrast`).toBeGreaterThanOrEqual(
      4.5,
    );
    if (item.border !== undefined)
      expect(item.border).toBeGreaterThanOrEqual(3);
  }
  await test.info().attach("theme-contrast", {
    body: JSON.stringify(ratios),
    contentType: "application/json",
  });
  await page.screenshot({
    path: "test-results/panel-mobile.png",
    fullPage: true,
  });
});

test("filters and searches the fleet, selects previews, and reconciles removed agents", async ({
  page,
}) => {
  let agents = [
    {
      id: "dev",
      name: "Developer",
      botUsername: "developer_bot",
      provisioning: "ready",
      botConnection: { status: "polling" },
      setupAccess: { bot: "linked", owner: "verified" },
    },
    {
      id: "writer",
      name: "Writer",
      botUsername: "writer_bot",
      provisioning: "pending",
      botConnection: { status: "not_started" },
      setupAccess: { bot: "linked", owner: "pending" },
    },
    {
      id: "research",
      name: "Research",
      botUsername: "research_bot",
      provisioning: "failed",
      botConnection: { status: "blocked" },
      setupAccess: { bot: "linked", owner: "pending" },
    },
  ];
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { agents } }),
  );
  await login(page);
  const overview = page.getByLabel("Agent overview");
  await expect(
    overview.locator(".stat").filter({ hasText: "Total agents" }),
  ).toContainText("03");
  await expect(
    overview.locator(".stat").filter({ hasText: "Configured" }),
  ).toContainText("01");
  await expect(
    overview.locator(".stat").filter({ hasText: "Needs attention" }),
  ).toContainText("01");
  const filters = page.getByRole("group", { name: "Filter agents" });
  await filters.getByRole("button", { name: /Needs attention/ }).click();
  await expect(
    page.getByRole("button", { name: "Select Research" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select Developer" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Manage", exact: true }),
  ).toHaveAttribute("href", "/agents/research/setup");
  await page.getByRole("searchbox", { name: "Search agents" }).fill("writer");
  await expect(
    page.getByRole("heading", { name: "No matching agents." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search agents" }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Select Writer" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("article", { name: "Selected agent" })
      .getByRole("heading", { name: "Writer" }),
  ).toBeVisible();
  agents = agents.filter((agent) => agent.id !== "writer");
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("button", { name: "Select Writer" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Select Developer" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("searchbox", { name: "Search agents" })
    .fill("RESEARCH_BOT");
  await expect(
    page.getByRole("button", { name: "Select Research" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select Developer" }),
  ).toHaveCount(0);
});

test("renders the reference-inspired dashboard across screen sizes without external assets", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Content Security Policy|Refused to/.test(message.text())
    )
      violations.push(message.text());
  });
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:3199"))
      external.push(request.url());
  });
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            id: "dev",
            name: "Developer",
            botUsername: "nimbot_developer_bot",
            provisioning: "ready",
            botConnection: { status: "polling" },
            setupAccess: { bot: "linked", owner: "verified" },
          },
          {
            id: "research",
            name: "Research assistant",
            botUsername: "nimbot_research_bot",
            provisioning: "ready",
            botConnection: { status: "polling" },
            setupAccess: { bot: "linked", owner: "pending" },
          },
          {
            id: "writer",
            name: "Content studio",
            botUsername: "nimbot_content_bot",
            provisioning: "provisioning",
            botConnection: { status: "connecting" },
            setupAccess: { bot: "linked", owner: "pending" },
          },
          {
            id: "ops",
            name: "Operations",
            botUsername: "nimbot_ops_bot",
            provisioning: "failed",
            botConnection: { status: "blocked" },
            setupAccess: { bot: "linked", owner: "pending" },
          },
          {
            id: "personal",
            name: "Personal assistant",
            botUsername: "nimbot_personal_bot",
            provisioning: "ready",
            botConnection: { status: "polling" },
            setupAccess: { bot: "linked", owner: "verified" },
          },
        ],
      },
    }),
  );
  await login(page);
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      document.fonts.check('400 14px "Manrope Variable"'),
    ),
  ).toBe(true);
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `overflow at ${width}px`,
    ).toBe(true);
    await expect(
      page.getByRole("link", { name: "Manage", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/dashboard-${width}.png`,
      fullPage: true,
    });
  }
  expect(violations).toEqual([]);
  expect(external).toEqual([]);
});

test("retries a failed setup from the agent page", async ({
  page,
  request,
}) => {
  await login(page);
  await request.post("/__test/fail/dev");
  await page.goto("/agents/dev/setup");
  await expect(page.getByText("Setup did not finish.")).toBeVisible();
  await page.getByRole("button", { name: "Retry setup" }).click();
  await expect(page.getByText("Setup restarted.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry setup" })).toHaveCount(
    0,
  );
});

test("configures, replaces, and removes Discord without changing Telegram", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "Manage" }).click();
  const discord = page.getByRole("region", { name: "Discord connection" });
  await expect(discord.getByText("Discord is not configured.")).toBeVisible();
  await discord
    .getByLabel("Owner's Discord user ID")
    .fill("987654321098765432");
  await discord
    .getByLabel("Discord bot token", { exact: true })
    .fill("invalid-token");
  await discord.getByRole("button", { name: "Connect Discord" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save Discord");
  await expect(
    discord.getByLabel("Discord bot token", { exact: true }),
  ).toHaveValue("");
  await expect(discord.getByLabel("Owner's Discord user ID")).toHaveValue(
    "987654321098765432",
  );
  await discord
    .getByLabel("Discord bot token", { exact: true })
    .fill("valid-discord-token");
  await discord.getByRole("button", { name: "Connect Discord" }).click();
  await expect(
    discord.getByText("notification_bot", { exact: true }),
  ).toBeVisible();
  await expect(
    discord.getByLabel("Discord bot token", { exact: true }),
  ).toHaveValue("");
  await page.reload();
  await expect(discord.getByLabel("Owner's Discord user ID")).toHaveValue(
    "987654321098765432",
  );
  await discord
    .getByLabel("Owner's Discord user ID")
    .fill("876543210987654321");
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(discord.getByLabel("Owner's Discord user ID")).toHaveValue(
    "876543210987654321",
  );
  await discord
    .getByLabel("Discord bot token", { exact: true })
    .fill("valid-discord-token");
  await discord
    .getByRole("button", { name: "Replace Discord connection" })
    .click();
  await expect(
    discord.getByText("876543210987654321", { exact: true }),
  ).toBeVisible();
  await expect(
    discord.getByRole("button", { name: "Remove Discord connection" }),
  ).toBeDisabled();
  await discord.getByLabel("Type dev to confirm removal").fill("dev");
  await discord
    .getByRole("button", { name: "Remove Discord connection" })
    .click();
  await expect(discord.getByText("Discord is not configured.")).toBeVisible();
  await expect(page.getByText("@developer_bot", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
});

test("sends Discord tests and reuses the request when checking uncertain delivery", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "Manage" }).click();
  await page.getByLabel("Owner's Discord user ID").fill("987654321098765432");
  await page
    .getByLabel("Discord bot token", { exact: true })
    .fill("valid-discord-token");
  await page.getByRole("button", { name: "Connect Discord" }).click();
  const ids: string[] = [];
  await page.route("**/api/agents/dev/discord/test", async (route) => {
    const body = new URLSearchParams(route.request().postData()!);
    expect([...body.keys()]).toEqual(["requestId"]);
    ids.push(body.get("requestId")!);
    await route.fulfill({
      json:
        ids.length === 1
          ? { status: "uncertain", sentParts: 0, reason: "unavailable" }
          : { status: "delivered", sentParts: 1 },
    });
  });
  await page
    .getByRole("button", { name: "Send Discord test", exact: true })
    .click();
  await expect(
    page.getByText("Discord delivery is uncertain.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check last test status" }).click();
  await expect(
    page.getByText("Discord test delivered.", { exact: true }),
  ).toBeVisible();
  expect(ids[1]).toBe(ids[0]);
  await page
    .getByRole("button", { name: "Send Discord test", exact: true })
    .click();
  await expect.poll(() => ids.length).toBe(3);
  expect(ids[2]).not.toBe(ids[0]);
});

test("shows independent Discord conversation and owner-link status while Telegram stays connected", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "Manage" }).click();
  await page.getByLabel("Owner's Discord user ID").fill("987654321098765432");
  await page
    .getByLabel("Discord bot token", { exact: true })
    .fill("valid-discord-token");
  await page.getByRole("button", { name: "Connect Discord" }).click();
  await expect(
    page.getByText("Discord conversation: Connected.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Owner DM: Waiting for the owner's first private message.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.route("**/api/agents/dev", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.discord.conversation = { state: "failed", ownerLinked: true };
    await route.fulfill({ json: body });
  });
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(
    page.getByText("Discord conversation: Connection failed.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Owner DM: Linked.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Telegram bot:", { exact: false })).toBeVisible();
  await expect(page.getByText("@developer_bot", { exact: true })).toBeVisible();
});
