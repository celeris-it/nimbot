import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function login(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Administrator password").fill("panel-test-password");
  await page.getByRole("button", { name: "Sign in to the panel" }).click();
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeVisible();
}

async function openAgentSection(page: Page, name: string) {
  const nav = page.getByRole("navigation", { name: "Agent navigation" });
  await expect(nav).toBeVisible();
  const link = nav.getByRole("link", { name, exact: true });
  if (!(await link.isVisible())) await nav.locator("summary").click();
  await link.click();
}

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test("renders the Nimbot logo on sign-in and in the desktop sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/login");
  const logo = page.getByRole("link", { name: "Nimbot home" }).locator("img");
  await expect(logo).toBeVisible();
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const favicon = page.locator('link[rel="icon"]');
  await expect(favicon).toHaveAttribute(
    "href",
    (await logo.getAttribute("src"))!,
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const sidebarLogo = page
    .getByRole("navigation", { name: "Main navigation" })
    .locator("img");
  await expect(sidebarLogo).toBeVisible();
  await expect
    .poll(() =>
      sidebarLogo.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
});

test("shows bot avatars in the dashboard and agent directory with initials as a fallback", async ({
  page,
}) => {
  const path = "**/api/agents/dev/avatar";
  await page.route(path, (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await login(page);
  const avatar = page
    .getByRole("link", { name: "Open Developer settings", exact: true })
    .locator(".agent-avatar");
  await expect(avatar.locator("img")).toBeVisible();

  await expect(page.getByLabel(/^Switch agent/)).toHaveCount(0);
  await page
    .getByRole("link", { name: "Open Developer settings", exact: true })
    .click();
  const switcher = page.getByLabel("Switch agent, Developer");
  await switcher.press("Enter");
  const option = page
    .locator('[data-ui="agent-switcher"]')
    .getByRole("link", { name: /^Developer/ });
  await expect(option.locator("img")).toBeVisible();
  await option.click();
  const current = page.getByLabel("Switch agent, Developer");
  await expect(current.locator("img")).toBeVisible();

  await page.setViewportSize({ width: 375, height: 800 });
  await expect(current.locator("img")).toBeVisible();
  await page.unroute(path);
  await page.route(path, (route) => route.fulfill({ status: 503 }));
  await page.reload();
  await expect(current.locator(".agent-avatar img")).toHaveCount(0);
  await expect(current.locator(".agent-avatar")).toHaveText("D");
  await switcher.press("Enter");
  await expect(option.locator(".agent-avatar")).toHaveText("D");
  await page.goto("/");
  await expect(avatar.locator("span")).toHaveText("D");
  await expect(avatar.locator("img")).toHaveCount(0);
  await expect(switcher).toHaveCount(0);
});

test("recovers an uncertain sign-in using the session", async ({ page }) => {
  await page.goto("/login");
  await page.route("**/api/login", (route) => route.abort(), { times: 1 });
  const password = page.getByLabel("Administrator password");
  const submit = page.getByRole("button", { name: "Sign in to the panel" });
  await password.fill("panel-test-password");
  await submit.click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not confirm sign-in",
  );
  await page.route("**/api/login", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await password.fill("panel-test-password");
  await submit.click();
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeVisible();
});

test("shows a wrong password beside the field and returns focus to it", async ({
  page,
}) => {
  await page.goto("/login");
  const password = page.getByLabel("Administrator password");
  await password.fill("wrong-password");
  await page.keyboard.press("Enter");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Incorrect password");
  await expect(
    page.locator('section[aria-label="Sign in"] form').getByRole("alert"),
  ).toBeVisible();
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toHaveValue("");
});

test("reveals and hides a password field on request", async ({ page }) => {
  await page.goto("/login");
  const password = page.getByLabel("Administrator password");
  await password.fill("panel-test-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show value" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).toHaveValue("panel-test-password");
  await page.getByRole("button", { name: "Hide value" }).click();
  await expect(password).toHaveAttribute("type", "password");
});

test("separates the destructive action and explains unavailable memory", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/setup");
  const danger = page.getByRole("region", { name: "Danger zone" });
  await expect(
    danger.getByRole("link", { name: "Delete agent…" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Start agent" })).toHaveClass(
    /panel-button-primary/,
  );
  await page.goto("/agents/dev/memory");
  await expect(page.getByText("Memory is unavailable")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Overview", exact: true }),
  ).toHaveAttribute("href", "/agents/dev/setup");
  await expect(
    page.getByRole("navigation", { name: "Memory pages" }),
  ).toHaveCount(0);
});

test("selects an agent model and shows its published quota in the panel", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/setup");
  await openAgentSection(page, "Model and usage");
  await expect(
    page.getByRole("heading", { name: "Model and usage for Developer" }),
  ).toBeFocused();
  const model = page.getByRole("button", { name: /Model for new turns/ });
  const search = page.getByRole("combobox", { name: "Search models" });
  const fixture = page.getByRole("option", {
    name: "Fixture model fixture/model",
  });
  await expect(model).toContainText("Automatic");
  await model.press("Enter");
  await expect(search).toBeFocused();
  await expect(page.getByRole("option", { name: "Automatic" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await search.press("ArrowDown");
  await expect(search).toHaveAttribute(
    "aria-activedescendant",
    (await fixture.getAttribute("id"))!,
  );
  await search.press("Enter");
  await expect(model).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "Model saved for new turns." }),
  ).toBeVisible();
  await page.reload();
  await expect(model).toContainText("Fixture model");
  await expect(page.getByText("Queue paused for quota")).toBeVisible({
    timeout: 12_000,
  });
  await expect(
    page.getByText("Console monthly", { exact: true }),
  ).toBeVisible();
  await model.click();
  await expect(fixture).toHaveAttribute("aria-selected", "true");
  await page.getByRole("option", { name: "Automatic" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Model saved for new turns." }),
  ).toBeVisible();
  await page.reload();
  await expect(model).toContainText("Automatic");
});

test("saves reasoning effort and recovers when the model loses its variants", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await page.goto("/agents/dev/usage");
  const model = page.getByRole("button", { name: /Model for new turns/ });
  const effort = page.getByRole("combobox", { name: "Reasoning effort" });
  const choose = async (name: string | RegExp) => {
    await model.click();
    await page.getByRole("option", { name }).click();
  };

  await expect(effort).toHaveCount(0);
  await choose(/Fixture model/);
  await expect(effort).toHaveValue("");
  await model.press("Tab");
  await expect(effort).toBeFocused();
  await effort.press("Space");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(effort).toHaveValue("high");
  await expect(effort).toBeEnabled();
  await page.reload();
  await expect(effort).toHaveValue("high");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  await page.setViewportSize({ width: 320, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await page.setViewportSize({ width: 1280, height: 812 });

  await choose(/Plain model/);
  await expect(effort).toHaveCount(0);
  await choose(/Fixture model/);
  await expect(effort).toHaveValue("");
  await effort.selectOption("high");
  await expect(effort).toHaveValue("high");
  await expect(effort).toBeEnabled();

  await page.route("**/api/agents/dev/models", async (route) => {
    const response = await route.fetch();
    const catalog = await response.json();
    for (const model of catalog.models) model.efforts = [];
    await route.fulfill({ response, json: catalog });
  });
  await page.reload();
  await expect(effort).toHaveValue("high");
  await expect(
    effort.getByRole("option", { name: "High (Unavailable)" }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Choose another reasoning effort or Default to resume the queue.",
    ),
  ).toBeVisible();
  await effort.selectOption({ label: "Default" });
  await expect(effort).toHaveCount(0);
});

test("shows model maker icons for direct and shared providers", async ({
  page,
}) => {
  await login(page);
  const entries = [
    [
      "opencode",
      "deepseek-v4.1-flash-free",
      "DeepSeek Flash",
      "simple-icons--deepseek",
    ],
    ["opencode", "mimo-v2.6-flash-free", "MiMo Flash", "simple-icons--xiaomi"],
    [
      "opencode",
      "nemotron-3.5-lightning-free",
      "Nemotron Lightning",
      "simple-icons--nvidia",
    ],
    ["opencode", "beam-free", "Beam Free", "coolicons--robot-duotone-round"],
    ["openai", "gpt-6.2-sol", "GPT Sol", "simple-icons--openai"],
    [
      "openrouter",
      "anthropic/claude-sonnet",
      "Claude Sonnet",
      "simple-icons--anthropic",
    ],
  ] as const;
  const models = entries.map(([providerId, modelId, name]) => ({
    providerId,
    modelId,
    name,
  }));
  await page.route("**/api/agents/dev/models", (route) =>
    route.fulfill({
      json: { selected: models[0], catalogAvailable: true, models },
    }),
  );
  await page.goto("/agents/dev/usage");
  const picker = page.getByRole("button", { name: /Model for new turns/ });
  await expect(picker.locator('[data-ui="icon"]').first()).toHaveClass(
    /simple-icons--deepseek/,
  );
  await picker.click();
  for (const [, id, name, brand] of entries) {
    const icon = page
      .getByRole("option", { name: `${name} ${id}`, exact: true })
      .locator('[data-ui="icon"]')
      .first();
    await expect(icon).toHaveClass(new RegExp(brand));
    await expect(icon).toHaveCSS("mask-image", /url\("data:image\/svg\+xml/);
  }
});

test("filters models and keeps an unavailable saved model visible", async ({
  page,
}) => {
  await login(page);
  let audioName = "Studio";
  await page.route("**/api/agents/dev/models", (route) =>
    route.fulfill({
      json: {
        selected: { providerId: "retired", modelId: "retired-model" },
        catalogAvailable: true,
        models: [
          { providerId: "openai", modelId: "vision-v1", name: "Studio" },
          {
            providerId: "openrouter",
            modelId: "vendor/audio-v1",
            name: audioName,
          },
        ],
      },
    }),
  );
  await page.goto("/agents/dev/usage");
  const model = page.getByRole("button", { name: /Model for new turns/ });
  const search = page.getByRole("combobox", { name: "Search models" });
  const results = page.getByRole("listbox", { name: "Models" });
  await expect(model).toContainText("retired/retired-model (Unavailable)");
  await expect(page.getByRole("button", { name: "Save model" })).toHaveCount(0);

  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await model.click();
    await expect(results).toBeInViewport();
    const bounds = (await results.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await search.press("Escape");
    await expect(model).toBeFocused();
  }

  await model.click();
  await search.fill("  sTuDiO  ");
  await expect(results.getByRole("option")).toHaveCount(2);
  await search.fill("VISION-V1");
  await expect(results.getByRole("option")).toHaveAccessibleName(
    "Studio vision-v1",
  );
  await search.fill("openrouter");
  await expect(
    results.getByRole("group", { name: "openrouter" }),
  ).toBeVisible();
  await expect(results.getByRole("option")).toHaveCount(1);
  await search.fill("unknown");
  await expect(
    page.getByRole("status").filter({ hasText: "No matching models" }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(model).toContainText("Unavailable");
  await expect(search).toBeFocused();
  await page.mouse.click(4, 4);
  await expect(search).toBeHidden();

  audioName = "Audio Studio";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await model.click();
  await search.fill("audio-v1");
  await expect(results.getByRole("option")).toHaveAccessibleName(
    "Audio Studio vendor/audio-v1",
  );
  await expect(model).toContainText("Unavailable");
});

test("explains why queued tasks are waiting after an OpenCode startup failure", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/agents/dev/usage", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        queued: 2,
        quota: {
          model: null,
          state: "checking",
          checkedAt: Date.now(),
          failure: "opencode_start_failed",
          windows: [],
        },
      },
    });
  });
  await page.goto("/agents/dev/usage");
  await expect(page.getByText("Model or quota check failed")).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "OpenCode exited before it could serve models" }),
  ).toBeVisible();
  await expect(page.getByText("2 queued", { exact: true })).toBeVisible();
});

test("shows ChatGPT quota in agent usage and the dashboard without a queue pause", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 850 });
  const resetsAt = Date.UTC(2026, 11, 1);
  await page.route("**/api/usage/overview*", (route) =>
    route.fulfill({
      json: {
        ...dashboardUsage,
        quotas: [
          {
            providerId: "openai",
            window: "ChatGPT 5-hour",
            remainingPercent: 0,
            resetsAt,
            exhausted: true,
          },
          {
            providerId: "openai",
            window: "ChatGPT weekly",
            remainingPercent: 34,
            resetsAt,
            exhausted: false,
          },
        ],
      },
    }),
  );
  await page.route("**/api/agents/dev/usage", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        quota: {
          model: { providerId: "openai", modelId: "gpt-6.2-sol" },
          state: "available",
          checkedAt: resetsAt - 60_000,
          windows: [
            {
              name: "ChatGPT 5-hour",
              usedPercent: 100,
              exhausted: true,
              resetsAt,
            },
            {
              name: "ChatGPT weekly",
              usedPercent: 66,
              exhausted: false,
              resetsAt,
            },
          ],
        },
      },
    });
  });
  await login(page);
  const dashboardQuota = page.getByLabel("Quota left", { exact: true });
  await expect(dashboardQuota.getByText("ChatGPT 5-hour")).toBeVisible();
  await expect(dashboardQuota.getByText("ChatGPT weekly")).toBeVisible();
  const tracks = dashboardQuota.locator("circle[data-track]");
  await expect(tracks).toHaveCount(2);
  await expect(
    dashboardQuota.locator("circle[data-track][stroke-dasharray]"),
  ).toHaveCount(0);
  await expect(dashboardQuota.locator("circle[data-slice]")).toHaveCount(1);
  await expect(
    dashboardQuota.locator('circle[data-slice="1"]'),
  ).toHaveAttribute("stroke-dasharray", "34 100");
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.goto("/agents/dev/usage");
  const quota = page.getByRole("region", { name: "Provider quota" });
  await expect(quota.getByText("Quota available")).toBeVisible();
  await expect(
    quota.getByRole("listitem").filter({ hasText: "ChatGPT 5-hour" }),
  ).toContainText(/100%\s+used.*0% left.*Limit reached.*Resets/s);
  await expect(
    quota.getByRole("listitem").filter({ hasText: "ChatGPT weekly" }),
  ).toContainText("34% left");
  await expect(quota.getByText(/Queue paused/)).toHaveCount(0);
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test("charts the four tightest quota windows and lists the rest", async ({
  page,
}) => {
  const windows = [
    "ChatGPT 5-hour",
    "Go rolling",
    "ChatGPT weekly",
    "Go weekly",
    "Go monthly",
  ];
  await page.route("**/api/usage/overview*", (route) =>
    route.fulfill({
      json: {
        ...dashboardUsage,
        quotas: windows.map((window, index) => ({
          providerId: window.startsWith("ChatGPT") ? "openai" : "opencode",
          window,
          remainingPercent: Math.min((index + 1) * 25, 100),
          resetsAt: Date.UTC(2026, 11, 1),
          exhausted: false,
        })),
      },
    }),
  );
  await login(page);
  const quota = page.getByRole("region", { name: "Quota left" });
  await expect(quota.locator("circle[data-slice]")).toHaveCount(4);
  await expect(quota.locator('circle[data-slice="3"]')).not.toHaveAttribute(
    "stroke-dasharray",
    /./,
  );
  await expect(quota.getByRole("listitem")).toHaveCount(5);
  await expect(quota.getByRole("listitem").last()).toContainText("Go monthly");
  await expect(
    quota.getByText("Rings show the four lowest remaining quotas."),
  ).toBeVisible();
});

test("keeps usage history readable and keyboard-scrollable on narrow screens", async ({
  page,
}) => {
  await login(page);
  const startedAt = Date.UTC(2026, 10, 22, 18);
  const totals = {
    tokens: 1500,
    costUsd: 0.0123,
    tasks: 2,
    missingCost: 1,
    incomplete: 1,
  };
  await page.route("**/api/agents/dev/usage*", (route) => {
    const older = new URL(route.request().url()).searchParams.has("before");
    return route.fulfill({
      json: {
        quota: null,
        queued: 0,
        today: totals,
        month: totals,
        next: older ? null : startedAt,
        tasks: older
          ? []
          : [
              {
                id: "completed",
                startedAt,
                status: "completed",
                origin: "schedule",
                scheduleName: "Nightly workspace summary",
                usage: {
                  model: {
                    providerId: "opencode",
                    modelId: "model-" + "x".repeat(120),
                  },
                  tokens: {
                    input: 1000,
                    output: 400,
                    reasoning: 100,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  costUsd: 0.0123,
                  state: "partial",
                },
              },
              {
                id: "failed",
                startedAt,
                status: "failed",
                origin: "telegram",
                scheduleName: null,
                usage: null,
              },
            ],
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/agents/dev/usage");
  const table = page.getByRole("table", { name: "Task usage history" });
  const scrollRegion = page.getByRole("region", {
    name: "Task usage history",
    exact: true,
  });
  const scrollHint = page.getByText("Scroll horizontally to see all columns.");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(scrollHint).toBeHidden();
  await expect(
    table.getByRole("columnheader", { name: "Reported cost (USD)" }),
  ).toHaveCSS("text-align", "end");
  await expect(table.getByRole("cell", { name: /1,500/ })).toHaveCSS(
    "text-align",
    "end",
  );
  const partial = table.getByRole("row", { name: /Completed/ });
  await expect(partial.getByText("Partial usage")).toBeVisible();
  await expect(partial.getByText("Nightly workspace summary")).toBeVisible();
  const failed = table.getByRole("row", { name: /Failed/ });
  await expect(failed.getByText("Unavailable", { exact: true })).toHaveCount(3);
  const history = page.locator(".table-panel");
  await expect(history).toHaveCSS("background-image", "none");
  await history.screenshot({
    path: test.info().outputPath("usage-desktop.png"),
  });

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 840 });
    await expect(scrollHint).toBeVisible();
    await expect(scrollRegion).toHaveAttribute("tabindex", "0");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    expect(await partial.evaluate((row) => row.offsetHeight)).toBeLessThan(180);
  }
  await history.screenshot({
    path: test.info().outputPath("usage-mobile.png"),
  });
  await scrollRegion.focus();
  await expect(scrollRegion).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => scrollRegion.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.keyboard.press("Tab");
  const older = page.getByRole("link", { name: "Older tasks" });
  await expect(older).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("No model tasks on this page.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Newest tasks" })).toBeVisible();
});

test("enables discovered MCP tools with one save", async ({ page }) => {
  await login(page);
  const saves: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/mcp"
    )
      saves.push(request.postDataJSON());
  });

  await page.getByRole("link", { name: "MCP catalog" }).click();
  const examples = page.getByRole("region", { name: "Examples" });
  await expect(examples.getByRole("link")).toHaveCount(24);
  const cards = examples.getByRole("listitem");
  await expect(cards).toHaveCount(24);
  for (const card of await cards.all())
    await expect(card).toHaveCSS("background-image", "none");
  const pageCard = page.locator("[data-page-card]");
  await expect(
    pageCard.getByRole("heading", { name: "MCP catalog" }),
  ).toBeVisible();
  await expect(
    pageCard.getByRole("searchbox", { name: "Search options" }),
  ).toBeVisible();
  await page.reload();
  await expect(cards).toHaveCount(24);
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  const search = examples.getByRole("searchbox", { name: "Search examples" });
  const results = examples.getByRole("status");
  await search.fill("  GITHUB  ");
  await expect(
    examples.getByRole("link", { name: "Set up DeepWiki" }),
  ).toBeVisible();
  await expect(
    examples.getByRole("link", { name: "Set up Context7" }),
  ).toHaveCount(0);
  await search.fill("xyzzy");
  await expect(results).toHaveText(
    "No matching examples. Try a different search or clear the field.",
  );
  await expect(cards).toHaveCount(0);
  await search.clear();
  await expect(cards).toHaveCount(24);
  await search.fill("OpenAI Docs");
  await expect(results).toHaveText("1 matching example");
  await expect(cards).toHaveCount(1);
  await expect(search).toBeFocused();
  const setup = examples.getByRole("link", { name: "Set up OpenAI Docs" });
  await page.keyboard.press("Tab");
  await expect(setup).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Set up OpenAI Docs" }),
  ).toBeFocused();
  await expect(page.getByLabel("Integration name")).toHaveValue("OpenAI Docs");
  const endpoint = page.getByLabel("HTTPS endpoint");
  await expect(endpoint).toHaveValue("https://developers.openai.com/mcp");
  await expect(endpoint).not.toBeEditable();
  const save = page.getByRole("button", { name: "Save integration" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByRole("heading", { name: "Edit OpenAI Docs" }),
  ).toBeVisible();
  await expect(page.getByText("Enabled 1 new MCP tools.")).toBeVisible();
  await expect(page.getByLabel("Tool name")).toHaveValue("lookup");
  await expect(
    page.getByRole("switch", { name: "Enable tool", exact: true }),
  ).toBeChecked();
  expect(saves).toMatchObject([{ label: "OpenAI Docs", tools: [] }]);
  await page.goto("/agents/dev/access");
  const integration = page.getByRole("region", { name: "OpenAI Docs" });
  await expect(integration.getByText(/Access withheld/)).toBeVisible();
  await expect(
    integration.getByRole("button", { name: "Grant access" }),
  ).toBeVisible();
});

test("enables all GitHub tools when the agent credential is saved", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "MCP catalog" }).click();
  const examples = page.getByRole("region", { name: "Examples" });
  await examples
    .getByRole("link", { name: "Set up GitHub", exact: true })
    .click();
  await expect(page.getByLabel("HTTPS endpoint")).toHaveValue(
    "https://api.githubcopilot.com/mcp/",
  );
  await expect(page.getByText(/save your personal access token/)).toBeVisible();
  const save = page.getByRole("button", { name: "Save integration" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByRole("heading", { name: "Edit GitHub" }),
  ).toBeVisible();
  const editUrl = page.url();
  await expect(page.getByLabel("Tool name")).toHaveCount(0);

  await page.goto("/agents/dev/access");
  const integration = page.getByRole("region", { name: "GitHub", exact: true });
  await integration.getByRole("button", { name: "Grant access" }).click();
  await integration
    .getByLabel("Bearer credential")
    .fill("example-github-credential");
  await integration.getByRole("button", { name: "Save credential" }).click();
  await expect(
    integration.getByRole("button", { name: "Replace credential" }),
  ).toBeVisible();

  await expect(page.getByText(/Enabled 46 new MCP tools/)).toBeVisible();
  await page.goto(editUrl);
  await expect(page.getByLabel("Tool name")).toHaveCount(46);
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.getByText("github_tool_46", { exact: true })).toBeVisible();
  const tool = page.getByRole("group", { name: "github_tool_46" });
  await page.getByText("github_tool_46", { exact: true }).press("Enter");
  await tool
    .getByRole("switch", { name: "Enable tool", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(page.getByText("Integration saved.")).toBeVisible();
  await page.getByLabel("Connection credential").selectOption("dev");
  await page.getByRole("button", { name: "Update tools" }).click();
  await expect(
    page.getByText("No new compatible MCP tools were found."),
  ).toBeVisible();
  await page.getByText(/github_tool_46 · Disabled/).click();
  await expect(
    tool.getByRole("switch", { name: "Enable tool", exact: true }),
  ).not.toBeChecked();
});

test("edits the MCP catalog and manages an agent's grant and write-only credential", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "MCP catalog" }).click();
  await page.getByRole("link", { name: "Add integration" }).click();
  await expect(
    page.getByRole("heading", { name: "Add MCP integration" }),
  ).toBeFocused();
  await page.getByLabel("Integration name").fill("Workspace docs");
  await page.getByLabel("HTTPS endpoint").fill("https://docs.example.test/mcp");
  await page.getByRole("switch", { name: "Enable integration" }).check();
  await page.getByRole("button", { name: "Add tool" }).click();
  await page.getByLabel("Tool name").fill("search");
  await page.getByLabel("Access", { exact: true }).selectOption("read");
  await page
    .getByLabel("Argument schema (JSON)")
    .fill('{"type":"object","properties":{"query":{"type":"string"}}}');
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(
    page.getByRole("heading", { name: "Edit Workspace docs" }),
  ).toBeVisible();
  await expect(page.getByLabel("Tool name")).toHaveValue("search");
  await page.getByLabel("Integration name").fill("Team docs");
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(
    page.getByRole("heading", { name: "Edit Team docs" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Integration name")).toHaveValue("Team docs");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Connected." }),
  ).toBeVisible();
  await expect(page.getByLabel("Tool name")).toHaveCount(1);
  await page.getByRole("button", { name: "Review tool" }).click();
  await expect(page.getByLabel("Tool name").last()).toHaveValue("lookup");
  await expect(page.getByLabel("Access", { exact: true }).last()).toHaveValue(
    "write",
  );
  await expect(page.getByLabel("Argument schema (JSON)").last()).toBeFocused();
  await page.reload();
  await expect(page.getByLabel("Tool name")).toHaveCount(1);

  await page.goto("/agents/dev/setup");
  await openAgentSection(page, "Access");
  await expect(
    page.getByRole("heading", { name: "Access for Developer" }),
  ).toBeFocused();
  const integration = page.getByRole("region", { name: "Team docs" });
  await expect(integration.getByText(/Access withheld/)).toBeVisible();
  await integration.getByRole("button", { name: "Grant access" }).click();
  const credential = integration.getByLabel("Bearer credential");
  await expect(credential).toHaveAttribute("type", "password");
  await credential.fill("example-panel-credential");
  await integration.getByRole("button", { name: "Save credential" }).click();
  await expect(
    integration.getByRole("button", { name: "Replace credential" }),
  ).toBeVisible();
  await expect(credential).toHaveValue("");
  await page.reload();
  await expect(credential).toHaveValue("");
  await expect(
    integration.getByRole("button", { name: "Remove credential" }),
  ).toBeVisible();
  await integration.getByRole("button", { name: "Remove credential" }).click();
  await expect(
    integration.getByRole("button", { name: "Save credential" }),
  ).toBeVisible();
  await integration.getByRole("button", { name: "Revoke access" }).click();
  await expect(integration.getByText(/Access withheld/)).toBeVisible();
  await expect(credential).toHaveCount(0);
});

test("keeps changed MCP tools disabled until an explicit schema review is saved", async ({
  page,
  request,
}) => {
  await login(page);
  await page.goto("/mcp/new");
  await page.getByLabel("Integration name").fill("Changed docs");
  await page
    .getByLabel("HTTPS endpoint")
    .fill("https://changed.example.test/mcp");
  await page.getByLabel("Enable integration").check();
  await page.getByRole("button", { name: "Add tool" }).click();
  await page.getByLabel("Tool name").fill("search");
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(
    page.getByRole("heading", { name: "Edit Changed docs" }),
  ).toBeVisible();
  const id = page.url().split("/").at(-1)!;
  expect((await request.post(`/__test/mcp/${id}/block/search`)).ok()).toBe(
    true,
  );
  await page.getByLabel("Integration name").fill("Stale draft");
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(page.getByRole("alert")).toContainText("MCP settings changed");
  await expect(page.getByLabel("Integration name")).toHaveValue("Stale draft");
  await page.reload();
  const review = page.getByLabel("I reviewed the schema and access for search");
  await expect(review).not.toBeChecked();
  await expect(page.getByRole("alert")).toContainText(
    "Some tools are disabled",
  );
  await page.getByLabel("Integration name").fill("Renamed changed docs");
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(
    page.getByRole("heading", { name: "Edit Renamed changed docs" }),
  ).toBeVisible();
  await expect(review).not.toBeChecked();
  await page.goto("/mcp");
  await expect(page.getByText("Review needed", { exact: true })).toBeVisible();
  await page.goto("/agents/dev/mcp");
  await expect(page).toHaveURL("/agents/dev/access");
  const integration = page.getByRole("region", {
    name: "Renamed changed docs",
  });
  await expect(
    integration.getByText("1 tool disabled pending review.", { exact: false }),
  ).toBeVisible();
  await integration.getByRole("link", { name: "Review tools" }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Connected." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review schema" }).click();
  await expect(page.getByLabel("Argument schema (JSON)")).toBeFocused();
  await expect(review).not.toBeChecked();
  await review.focus();
  await page.keyboard.press("Space");
  await expect(review).toBeChecked();
  await page.getByLabel("Access", { exact: true }).selectOption("read");
  await expect(review).not.toBeChecked();
  await review.focus();
  await page.keyboard.press("Space");
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/mcp-review-${width}.png`,
      fullPage: true,
    });
  }
  const colors = await page
    .getByRole("alert")
    .filter({ hasText: "Some tools are disabled" })
    .evaluate((element) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const hex = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return (
          "#" +
          Array.from(context.getImageData(0, 0, 1, 1).data)
            .slice(0, 3)
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("")
        );
      };
      return { text: hex(style.color), background: hex(style.backgroundColor) };
    });
  await test.info().attach("mcp-review-colors", {
    body: JSON.stringify(colors),
    contentType: "application/json",
  });
  await page.getByRole("button", { name: "Save integration" }).click();
  await expect(review).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText("Disabled pending review.", { exact: false }),
  ).toHaveCount(0);
  await page.goto("/mcp");
  await expect(page.getByText("Review needed", { exact: true })).toHaveCount(0);
});

test("manages peer grants, reads approval history and deletes private memory", async ({
  page,
  request,
}) => {
  const researcher = randomUUID();
  expect((await request.post(`/__test/capabilities/${researcher}`)).ok()).toBe(
    true,
  );
  await login(page);
  await page.goto("/agents/dev/setup");
  await openAgentSection(page, "Access");
  await expect(page.getByText("No grants.", { exact: false })).toBeVisible();
  await page.getByLabel("Target agent").selectOption({ label: "Researcher" });
  await page.getByLabel("Permission").selectOption({ label: "Delegate tasks" });
  await page.getByRole("button", { name: "Add grant" }).click();
  const revoke = page.getByRole("button", {
    name: "Revoke Delegate tasks to Researcher",
  });
  await expect(revoke).toBeVisible();
  await page.reload();
  await revoke.click();
  await expect(page.getByText("No grants.", { exact: false })).toBeVisible();

  await page.goto(`/agents/${researcher}/setup`);
  await openAgentSection(page, "Approvals");
  await expect(
    page.getByRole("heading", { name: "Decision history" }),
  ).toBeVisible();
  const decision = page
    .getByRole("listitem")
    .filter({ hasText: "Send research note" });
  await expect(decision).toContainText("approved");
  await expect(decision).toContainText("decided by telegram:42");
  await expect(decision).toContainText("execution: completed");
  await page.getByRole("link", { name: "Back to agent" }).click();
  await openAgentSection(page, "Memory");
  await expect(
    page.getByRole("heading", { name: "Research notes" }),
  ).toBeVisible();
  await expect(page.getByText("Primary source verified")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Turn memory (on|off)/ }),
  ).toHaveCount(0);
  const deleteNote = page.getByRole("button", {
    name: "Delete note Research notes",
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await deleteNote.click();
  await expect(deleteNote).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await deleteNote.click();
  await expect(
    page.getByRole("status").filter({ hasText: "No saved notes" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Memory of Researcher" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "No saved notes" }),
  ).toBeVisible();
});

test("opens agent settings and schedule help with the keyboard", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await login(page);

  const ruleAgent = randomUUID();
  expect((await request.post(`/__test/agent/${ruleAgent}`)).ok()).toBe(true);
  await page.goto(`/agents/${ruleAgent}/approvals`);
  const capability = page.getByLabel("Capability", { exact: true });
  await expect(capability).toBeHidden();
  await page.getByText("Add a rule", { exact: true }).press("Enter");
  await page.keyboard.press("Tab");
  await expect(capability).toBeFocused();
  await capability.fill("mcp.docs.write");
  await page.getByLabel("Exact target").fill("document-42");
  await page.getByLabel("Rule", { exact: true }).selectOption("deny");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Revoke rule for mcp.docs.write on document-42",
    }),
  ).toBeVisible();

  await page.goto("/agents/dev/schedules");
  await expect(
    page.getByRole("status").filter({ hasText: "No schedules yet." }),
  ).toBeVisible();
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.locator("[data-ui=schedules]").screenshot({
      path: info.outputPath(`schedules-empty-${width}.png`),
    });
  }
  const rules = page.getByText(/^Stopped or unavailable agents are skipped/);
  await expect(rules).toBeHidden();
  await page.getByText("How schedules run", { exact: true }).press("Enter");
  await expect(rules).toBeVisible();
  await page
    .getByRole("button", { name: "New schedule", exact: true })
    .press("Enter");
  await expect(page.getByLabel("Schedule name")).toBeFocused();
});

test("pages through delegation history and cancels only the selected child", async ({
  page,
  request,
}) => {
  const source = randomUUID();
  expect((await request.post(`/__test/agent/${source}`)).ok()).toBe(true);
  expect((await request.post(`/__test/delegations/${source}`)).ok()).toBe(true);
  await login(page);
  await page.goto(`/agents/${source}/setup`);
  await openAgentSection(page, "Delegations");
  await expect(
    page.getByRole("heading", { name: "Delegations from Researcher" }),
  ).toBeFocused();
  const history = page.getByRole("list", { name: "Delegation history" });
  const row = (brief: number) =>
    history.getByRole("listitem").filter({
      has: page.getByText(`Brief ${brief} <em>as text</em>`, { exact: true }),
    });
  const selected = row(21);
  await expect(selected.getByText("Queued", { exact: true })).toBeVisible();
  await expect(selected.locator("em")).toHaveCount(0);
  await selected.getByRole("button", { name: "Cancel child" }).click();
  await expect(selected.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(selected.getByRole("button")).toHaveCount(0);
  await expect(row(20).getByText("Queued", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(row(1).getByText("Completed", { exact: true })).toBeVisible();
  await expect(row(1).getByRole("button")).toHaveCount(0);
  await expect(page.getByText("Private child output")).toHaveCount(0);
  await expect(page.getByText("Private parent prompt")).toHaveCount(0);
  await page.reload();
  await expect(row(1)).toBeVisible();
  await page.getByRole("link", { name: "Previous" }).click();
  await expect(selected.getByText("Cancelled", { exact: true })).toBeVisible();
});

async function openProviders(page: Page) {
  await login(page);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "AI providers" })
    .click();
  await expect(
    page.getByRole("heading", { name: "AI providers" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/providers$/);
}

async function openSchedules(page: Page) {
  await login(page);
  await page
    .getByRole("link", { name: "Open Developer settings", exact: true })
    .click();
  await openAgentSection(page, "Overview");
  await page.getByRole("button", { name: "Start agent", exact: true }).click();
  await openAgentSection(page, "Schedules");
  await expect(
    page.getByRole("heading", { name: "Schedules for Developer" }),
  ).toBeVisible();
}

async function scheduleDraft(page: Page, name = "Daily summary") {
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await expect(page.getByLabel("Schedule name", { exact: true })).toBeFocused();
  await page.getByLabel("Schedule name", { exact: true }).fill(name);
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Summarize the latest workspace changes.");
}

test("creates, edits, pauses, resumes, runs and deletes schedules with confirmation", async ({
  page,
  request,
}) => {
  await openSchedules(page);
  await expect(page.getByText(/^Owner chat is not linked\./)).toBeVisible();
  await expect(
    page.getByText("Every run uses this agent's AI provider credits.", {
      exact: false,
    }),
  ).toBeVisible();
  await scheduleDraft(page);
  await expect(page.getByLabel("Time zone", { exact: true })).toHaveValue(
    "UTC",
  );
  await page.getByLabel("Time zone", { exact: true }).fill("Europe/Madrid");
  await page.getByLabel("Time of day").fill("10:30");
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  let card = page.getByRole("region", { name: "Daily summary", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText("Daily at 10:30", { exact: true })).toBeVisible();
  await expect(card.locator("dd").first()).toContainText("Europe/Madrid");
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(card.getByText("Paused", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Not run:" }),
  ).toContainText("owner chat is not linked");
  await request.post("/__test/owner/dev");
  await page
    .getByRole("button", { name: "Refresh schedules", exact: true })
    .click();
  await expect(page.getByText(/^Owner chat is not linked\./)).not.toBeVisible();
  await card.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(card.locator("dd").last()).toHaveText("Completed");
  await card.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(
    card.getByText("Skipped: agent unavailable or owner chat unlinked"),
  ).toBeVisible();
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Schedule name", { exact: true }).fill("Weekly review");
  const channel = page.getByLabel("Delivery channel", { exact: true });
  await expect(channel).toHaveValue("telegram");
  await channel.selectOption("discord");
  await expect(
    page.getByText("Link the Discord owner chat to run this schedule."),
  ).toBeVisible();
  await page.getByLabel("Activation", { exact: true }).selectOption("weekly");
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Friday", { exact: true }).check();
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  card = page.getByRole("region", { name: "Weekly review", exact: true });
  await expect(
    card.getByText("Delivery via Discord (owner chat unlinked)"),
  ).toBeVisible();
  await expect(
    card.getByText("Every Monday, Friday at 10:30", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card).toBeVisible();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain('Delete schedule "Weekly review"');
    return dialog.accept();
  });
  await card.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card).not.toBeVisible();
  await expect(
    page.getByText("No schedules yet.", { exact: false }),
  ).toBeVisible();
});

test("steps the schedule interval within its minimum", async ({ page }) => {
  await openSchedules(page);
  await scheduleDraft(page, "Stepper schedule");
  await page.getByLabel("Activation", { exact: true }).selectOption("interval");
  const minutes = page.getByLabel("Interval in minutes");
  await minutes.fill("30");
  await page.getByRole("button", { name: "Increase" }).click();
  await expect(minutes).toHaveValue("31");
  const min = await minutes.getAttribute("min");
  await minutes.fill(min ?? "1");
  await page.getByRole("button", { name: "Decrease" }).click();
  await expect(minutes).toHaveValue(min ?? "1");
});

test("edits the global schedule time zone and prefills new schedules", async ({
  page,
}) => {
  await openSchedules(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const zone = page.getByRole("textbox", { name: "Schedule time zone" });
  await expect(zone).toHaveCSS("height", "44px");
  await expect(page.getByRole("combobox", { name: "Appearance" })).toHaveCSS(
    "height",
    "44px",
  );
  await expect(zone).toHaveValue("UTC");
  const save = page.getByRole("button", { name: "Save time zone" });
  const form = page.locator("form").filter({ has: zone });
  await zone.fill("Not/A_Time_Zone");
  await save.click();
  await expect(form.getByRole("alert")).toHaveText(
    "Time zone must be a valid IANA time zone name.",
  );
  await expect(zone).toBeFocused();
  await expect(zone).toHaveAttribute("aria-invalid", "true");
  await expect(zone).toHaveAccessibleDescription(/valid IANA time zone name/);
  await expect(zone).toHaveValue("Not/A_Time_Zone");
  await zone.fill("Europe/Madrid");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(zone).not.toHaveAttribute("aria-invalid");
  await zone.press("Enter");
  await expect(form.getByRole("status")).toHaveText(
    "Schedule time zone saved.",
  );
  await page.reload();
  await expect(zone).toHaveValue("Europe/Madrid");
  await page.goto("/agents/dev/schedules");
  await scheduleDraft(page);
  await expect(page.getByLabel("Time zone", { exact: true })).toHaveValue(
    "Europe/Madrid",
  );
});

test("aligns Settings controls without overflow across viewport sizes", async ({
  page,
}, info) => {
  await login(page);
  await page.goto("/settings");
  const appearance = page.getByRole("combobox", { name: "Appearance" });
  const zone = page.getByRole("textbox", { name: "Schedule time zone" });
  const save = page.getByRole("button", { name: "Save time zone" });
  await expect(appearance).toBeVisible();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      colorScheme,
    );
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      const alignment = await zone.evaluate((input, wide) => {
        const appearanceBox = document
          .getElementById("panel-appearance")
          ?.getBoundingClientRect();
        const zoneBox = input.getBoundingClientRect();
        const saveBox = input
          .closest("form")
          ?.querySelector('button[type="submit"]')
          ?.getBoundingClientRect();
        const descriptionBox = input
          .closest("section")
          ?.querySelector(".settings-section-description")
          ?.getBoundingClientRect();
        return {
          fieldsAlign:
            appearanceBox?.x === zoneBox.x &&
            appearanceBox.width === zoneBox.width,
          buttonAligns:
            saveBox?.x === zoneBox.x && saveBox.width < zoneBox.width,
          descriptionFits:
            descriptionBox !== undefined &&
            (wide
              ? descriptionBox.right < zoneBox.left
              : descriptionBox.bottom < zoneBox.top),
        };
      }, width >= 1280);
      expect(alignment).toEqual({
        fieldsAlign: true,
        buttonAligns: true,
        descriptionFits: true,
      });
      await page.screenshot({
        path: info.outputPath(`settings-${colorScheme}-${width}.png`),
      });
    }
    await appearance.focus();
    await appearance.press("Tab");
    const language = page.getByRole("combobox", { name: "Language" });
    await expect(language).toBeFocused();
    await language.press("Tab");
    await expect(zone).toBeFocused();
    await expect(zone).toHaveCSS("outline-style", "solid");
    await zone.press("Tab");
    await expect(save).toBeFocused();
  }
});

for (const kind of ["once", "interval"] as const) {
  test(`creates ${kind} schedules and restores the matching form fields`, async ({
    page,
  }) => {
    await openSchedules(page);
    await scheduleDraft(page, `${kind} schedule`);
    await page.getByLabel("Activation", { exact: true }).selectOption(kind);
    await page.getByLabel("Time zone", { exact: true }).fill("UTC");
    const date = new Date(Date.now() + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (kind === "once") {
      await page.getByLabel("Date", { exact: true }).fill(date);
      await page.getByLabel("Time of day").fill("12:45");
    } else await page.getByLabel("Interval in minutes").fill("30");
    await page
      .getByRole("button", { name: "Create schedule", exact: true })
      .click();
    const card = page.getByRole("region", {
      name: `${kind} schedule`,
      exact: true,
    });
    await expect(card).toContainText(
      kind === "once" ? `Once on ${date} at 12:45` : "Every 30 minutes",
    );
    await page.reload();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByLabel("Activation", { exact: true })).toHaveValue(
      kind,
    );
    if (kind === "once")
      await expect(page.getByLabel("Date", { exact: true })).toHaveValue(date);
    else await expect(page.getByLabel("Interval in minutes")).toHaveValue("30");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "New schedule", exact: true }),
    ).toBeFocused();
  });
}

test("preserves schedule drafts through refresh and errors with keyboard focus on validation", async ({
  page,
}) => {
  await openSchedules(page);
  await page.getByRole("button", { name: "New schedule", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Schedule name", { exact: true })).toBeFocused();
  await page.getByLabel("Schedule name", { exact: true }).fill("Draft to keep");
  await page.getByLabel("Prompt", { exact: true }).fill("Keep this prompt");
  await page.getByLabel("Activation", { exact: true }).selectOption("weekly");
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(page.locator("#schedule-form-error")).toHaveText(
    "Select at least one weekday.",
  );
  await expect(page.locator("#schedule-form-error")).toBeFocused();
  await page.getByLabel("Tuesday", { exact: true }).check();
  await expect(page.getByLabel("Tuesday", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await page.getByLabel("Time zone", { exact: true }).fill("Not/AZone");
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(page.locator("#schedule-form-error")).toContainText(
    "valid IANA time zone",
  );
  await expect(page.getByLabel("Time zone", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.getByLabel("Time zone", { exact: true }).fill("UTC");
  await page
    .getByRole("button", { name: "Refresh schedules", exact: true })
    .click();
  await expect(page.getByLabel("Schedule name", { exact: true })).toHaveValue(
    "Draft to keep",
  );
  await expect(page.getByLabel("Tuesday", { exact: true })).toBeChecked();
  await page.route("**/api/agents/dev/schedules", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: 400,
      json: { error: "Schedule could not be saved. Try again." },
    });
  });
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(page.locator("#form-error")).toContainText(
    "Schedule could not be saved",
  );
  await expect(page.locator("#form-error")).toBeFocused();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Keep this prompt",
  );
  await page.unroute("**/api/agents/dev/schedules");
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Draft to keep", exact: true }),
  ).toBeVisible();
});

test("keeps schedules isolated when navigating between agents", async ({
  page,
  request,
}) => {
  await openSchedules(page);
  await scheduleDraft(page);
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Daily summary", exact: true }),
  ).toBeVisible();
  await request.post("/__test/agent/research");
  await page.goto("/agents/research/schedules");
  await expect(
    page.getByRole("heading", { name: "Schedules for Researcher" }),
  ).toBeVisible();
  await expect(
    page.getByText("No schedules yet.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Daily summary", exact: true }),
  ).not.toBeVisible();
});

test("reflows the schedule list and form at desktop and narrow mobile widths", async ({
  page,
}, info) => {
  await openSchedules(page);
  await expect(page.locator("#new-schedule")).toHaveCSS(
    "background-image",
    "none",
  );
  await scheduleDraft(page, "A".repeat(60));
  await page
    .getByLabel("Time zone", { exact: true })
    .fill("America/Argentina/Catamarca");
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  const card = page.getByRole("region", { name: "A".repeat(60), exact: true });
  await expect(
    card.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCSS("background-image", "none");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByLabel("Schedule name", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`schedules-${width}.png`),
      fullPage: true,
    });
  }
});

test("groups the provider settings and agent directory inside the page card", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openProviders(page);
  const card = page.locator("[data-page-card]");
  const switcher = card.getByLabel("Switch agent", { exact: true });
  const search = card.getByRole("searchbox", { name: "Search options" });
  const title = card.getByRole("heading", { name: "AI providers" });
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(card).toHaveCSS("background-image", /^radial-gradient\(circle/);
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  expect((await card.boundingBox())?.y).toBe((await sidebar.boundingBox())?.y);
  const forms = card.locator(".panel-card");
  await expect(forms).toHaveCount(5);
  for (const form of await forms.all())
    await expect(form).toHaveCSS("background-image", "none");
  const keyButtons = card.getByRole("button", { name: "Save API key" });
  expect(await keyButtons.count()).toBeGreaterThan(0);
  for (const button of await keyButtons.all()) {
    await expect(button).toHaveCSS("background-color", "rgb(91, 156, 255)");
    await expect(button).toHaveCSS("background-image", "none");
    await expect(button.locator('[data-ui="icon"]')).toBeVisible();
  }

  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const titleBox = (await title.boundingBox())!;
    expect((await switcher.boundingBox())!.y).toBeLessThan(titleBox.y);
    expect((await search.boundingBox())!.y).toBeLessThan(titleBox.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: info.outputPath(`providers-${width}.png`),
      fullPage: true,
    });
  }
});

test("manages global API keys with keyboard navigation and blank secret fields", async ({
  page,
  request,
}) => {
  await openProviders(page);
  for (const [name, brand] of [
    ["OpenAI", "openai"],
    ["Anthropic", "anthropic"],
    ["Google", "google"],
    ["OpenRouter", "openrouter"],
    ["OpenCode Console", "opencode"],
  ]) {
    const icon = page
      .getByRole("heading", { name, exact: true })
      .locator('[data-ui="icon"]');
    await expect(icon).toHaveClass(new RegExp(`simple-icons--${brand}`));
    await expect(icon).toHaveCSS("mask-image", /url\("data:image\/svg\+xml/);
  }
  const openai = page.getByRole("region", { name: "OpenAI", exact: true });
  const key = page.getByLabel("OpenAI API key", { exact: true });
  await expect(
    openai.getByText("Not configured", { exact: true }),
  ).toBeVisible();
  await key.fill("private-first");
  await page.keyboard.press("Tab");
  await expect(
    openai.getByRole("button", { name: "Show value" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    openai.getByRole("button", { name: "Save API key" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    openai.getByText("Configured — API key", { exact: true }),
  ).toBeVisible();
  await expect(key).toHaveValue("");
  await key.fill("private-replacement");
  await openai.getByRole("button", { name: "Replace with API key" }).click();
  await expect(page.getByRole("status")).toContainText(
    "API key saved for all agents.",
  );
  await page.reload();
  await expect(key).toHaveValue("");
  await key.fill("invalid key");
  await openai.getByRole("button", { name: "Replace with API key" }).click();
  await expect(page.getByRole("alert")).toContainText("without whitespace");
  await expect(page.getByRole("alert")).toBeFocused();
  await expect(key).toHaveValue("");
  await request.post("/__test/agent/research");
  await page.goto("/agents/research/providers");
  await expect(page).toHaveURL(/\/providers$/);
  await expect(openai.getByText("Configured — API key")).toBeVisible();
  const disconnect = openai.getByRole("button", {
    name: "Disconnect provider",
  });
  const confirmation = page.getByRole("dialog", { name: "Disconnect OpenAI?" });
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(disconnect).toHaveCSS("align-items", "center");
  await disconnect.click();
  await expect(confirmation).toBeInViewport();
  const dialogBox = (await confirmation.boundingBox())!;
  expect(dialogBox.x).toBeGreaterThanOrEqual(16);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(304);
  await expect(
    confirmation.getByRole("button", { name: "Keep connected" }),
  ).toBeFocused();
  await expect(confirmation).toContainText("for all agents");
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(disconnect).toBeFocused();
  await expect(openai.getByText("Configured — API key")).toBeVisible();
  await page.keyboard.press("Enter");
  await confirmation
    .getByRole("button", { name: "Disconnect provider" })
    .click();
  await expect(
    openai.getByText("Not configured", { exact: true }),
  ).toBeVisible();
  await page.goto("/agents/dev/providers");
  await expect(
    openai.getByText("Not configured", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("private-");
});

test("completes device login and recovers its pending state after reload", async ({
  page,
  request,
}) => {
  await openProviders(page);
  await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(
    page.getByRole("link", { name: "OpenAI device authorization" }),
  ).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await expect(page.getByLabel("OpenAI API key")).toBeDisabled();
  const openai = page.getByRole("region", { name: "OpenAI", exact: true });
  await expect(openai).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const [identity, controls] = await Promise.all([
      openai.locator(".settings-section-description").boundingBox(),
      openai.locator(":scope > .panel-card").boundingBox(),
    ]);
    if (!identity || !controls) throw new Error("Expected provider settings");
    const [field, save] = await Promise.all([
      openai.locator('[data-ui="field-group"]').boundingBox(),
      openai
        .getByRole("button", { name: "Save API key", exact: true })
        .boundingBox(),
    ]);
    if (!field || !save) throw new Error("Expected API key controls");
    expect(field.height).toBe(44);
    expect(save.height).toBe(field.height);
    expect(field.x + field.width).toBeLessThanOrEqual(
      controls.x + controls.width - 16,
    );
    if (width === 1280) {
      expect(field.y).toBeCloseTo(save.y);
      expect(controls.x - identity.x - identity.width).toBeCloseTo(24);
      expect(controls.y).toBeCloseTo(identity.y);
    } else {
      expect(controls.x).toBeCloseTo(identity.x);
      expect(controls.y - identity.y - identity.height).toBeCloseTo(16);
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    if (width !== 375)
      await openai.screenshot({
        path: test.info().outputPath(`provider-authorization-${width}.png`),
      });
  }
  await page.reload();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await request.post("/__test/providers/completed");
  await expect(
    page.getByText("ChatGPT login completed for all agents."),
  ).toBeVisible();
  const badge = page.getByText("Configured — ChatGPT device login", {
    exact: true,
  });
  await expect(badge).toBeVisible();
  const icon = badge.locator('[data-ui="icon"]');
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon).toHaveCSS("mask-image", /url\("data:image\/svg\+xml/);
  await expect(page.getByLabel("OpenAI API key")).toBeEnabled();
});

test("cancels device login and preserves an existing API key", async ({
  page,
}) => {
  await openProviders(page);
  const openai = page.getByRole("region", { name: "OpenAI", exact: true });
  await page.getByLabel("OpenAI API key").fill("private-existing");
  await openai.getByRole("button", { name: "Save API key" }).click();
  await expect(openai.getByText("Configured — API key")).toBeVisible();
  await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await page.getByRole("button", { name: "Cancel device login" }).click();
  await expect(
    page.getByText("Device login cancelled. The previous credential was kept."),
  ).toBeVisible();
  await expect(openai.getByText("Configured — API key")).toBeVisible();
});

for (const state of ["failed", "expired", "restart"])
  test(`handles ${state} device login`, async ({ page, request }) => {
    await openProviders(page);
    await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
    await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
    await request.post(`/__test/providers/${state}`);
    await expect(
      page.getByText(
        state === "failed"
          ? "Device login failed."
          : state === "expired"
            ? "Device login exceeded its ten-minute time limit."
            : "The previous login was interrupted.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in with ChatGPT" }),
    ).toBeEnabled();
  });

test("shows provider busy and startup failures and recovers on refresh", async ({
  page,
  request,
}) => {
  await openProviders(page);
  await request.post("/__test/providers/busy");
  await expect(
    page.getByText("An authentication change is in progress."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with ChatGPT" }),
  ).toBeDisabled();
  await request.post("/__test/providers/idle");
  await request.post("/__test/providers/missing-opencode");
  await page.goto("/agents/dev/providers");
  await expect(
    page.getByRole("status").filter({ hasText: "OpenCode is missing" }),
  ).toBeVisible();
  await request.post("/__test/providers/idle");
  await page.getByRole("button", { name: "Refresh provider settings" }).click();
  await expect(
    page.getByRole("region", { name: "OpenAI", exact: true }),
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
  await page
    .getByRole("link", { name: "Open Developer settings", exact: true })
    .click();
  await expect(page).toHaveURL("/agents/dev/settings");
  await expect(
    page.getByRole("heading", { name: "Edit agent." }),
  ).toBeFocused();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Developer",
  );
  await page.reload();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Developer",
  );
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Edit agent." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(violations).toEqual([]);
});

test("creates an agent using only Discord and defaults new schedules to Discord", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await login(page);
  await page.getByRole("link", { name: "Create agent", exact: true }).click();
  await expect(page.getByLabel("Owner's Telegram ID")).toHaveCount(0);
  await expect(page.getByLabel("Discord bot token")).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill("Researcher");
  await page.keyboard.press("Tab");
  const instructions = page.getByLabel("Instructions (optional)");
  await expect(instructions).toBeFocused();
  await instructions.fill("Be concise");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Create agent" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/agents\/created\/setup$/);
  await expect(
    page.getByRole("heading", { name: "Agent Host running." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Manage channels" }).click();
  const discord = page.getByRole("region", { name: "Discord connection" });
  const setupGuide = discord.getByRole("heading", {
    name: "Set up a Discord bot",
  });
  await expect(setupGuide).toBeVisible();
  await expect(
    discord.getByRole("link", { name: "Discord Developer Portal" }),
  ).toHaveAttribute("href", "https://discord.com/developers/applications");
  const userIdGuide = discord.getByRole("link", {
    name: "Discord's user ID instructions",
  });
  await expect(userIdGuide).toHaveAttribute(
    "href",
    "https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID",
  );
  const accountInstallGuide = discord.getByRole("link", {
    name: "Discord's account installation guide",
  });
  await expect(accountInstallGuide).toHaveAttribute(
    "href",
    "https://docs.discord.com/developers/quick-start/getting-started#install-to-user-account",
  );
  await accountInstallGuide.focus();
  await page.keyboard.press("Tab");
  await expect(userIdGuide).toBeFocused();
  await discord.getByRole("button", { name: "Connect Discord" }).focus();
  await page.keyboard.press("Tab");
  const dmHelp = discord.getByText("Trouble opening a Discord DM?", {
    exact: true,
  });
  await expect(dmHelp).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    discord.getByRole("link", { name: "Discord's installation guide" }),
  ).toHaveAttribute(
    "href",
    "https://docs.discord.com/developers/quick-start/getting-started#installing-your-app",
  );
  await expect(
    discord.getByRole("link", { name: "Discord DM settings" }),
  ).toHaveAttribute(
    "href",
    "https://support.discord.com/hc/en-us/articles/217916488-Blocking-Privacy-Settings",
  );
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    for (const platform of ["Telegram", "Discord"]) {
      const section = page.getByRole("region", {
        name: `${platform} connection`,
      });
      const steps = await section.getByRole("list").boundingBox();
      const form = await section.locator("form").boundingBox();
      expect(form!.y).toBeGreaterThanOrEqual(steps!.y + steps!.height);
    }
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await discord
    .getByLabel("Owner's Discord user ID")
    .fill("987654321098765432");
  await discord.getByLabel("Discord bot token").fill("valid-discord-token");
  await discord.getByRole("button", { name: "Connect Discord" }).click();
  await expect(
    discord.getByText("notification_bot", { exact: true }),
  ).toBeVisible();
  await expect(setupGuide).toHaveCount(0);
  await expect(dmHelp).toBeVisible();
  await expect(
    discord.getByRole("paragraph").filter({ hasText: "link the DM" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Telegram" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Replace bot token" }),
  ).toHaveCount(0);
  await request.post("/__test/discord-owner/created");
  await openAgentSection(page, "Schedules");
  await page.getByRole("button", { name: "New schedule" }).click();
  await expect(page.getByLabel("Delivery channel")).toHaveValue("discord");
});

test("connects Telegram after creation and clears rejected tokens", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: "Create agent", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Researcher");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(/\/agents\/created\/setup$/);
  await openAgentSection(page, "Channels");
  const telegram = page.getByRole("region", { name: "Telegram connection" });
  const setupGuide = telegram.getByRole("heading", {
    name: "Set up a Telegram bot",
  });
  await expect(setupGuide).toBeVisible();
  const botFather = telegram.getByRole("link", { name: "@BotFather" });
  await expect(botFather).toHaveAttribute("href", "https://t.me/BotFather");
  await expect(botFather).toHaveAttribute("target", "_blank");
  await expect(
    telegram.getByRole("link", { name: "@userinfobot" }),
  ).toHaveAttribute("href", "https://t.me/userinfobot");
  await telegram.getByLabel("Owner's Telegram ID").fill("42");
  const token = telegram.getByLabel("Telegram bot token");
  await token.fill("wrong-token");
  await telegram.getByRole("button", { name: "Connect Telegram" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not connect Telegram",
  );
  await expect(telegram.getByLabel("Owner's Telegram ID")).toHaveValue("42");
  await expect(setupGuide).toBeVisible();
  await expect(token).toHaveValue("");
  await token.fill("valid-token");
  await telegram.getByRole("button", { name: "Connect Telegram" }).click();
  await expect(
    telegram.getByText("@developer_bot", { exact: true }),
  ).toBeVisible();
  await expect(setupGuide).toHaveCount(0);
  await expect(
    telegram.getByRole("link", { name: "Replace bot token" }),
  ).toBeVisible();
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
  await expect(page.getByLabel("Switch agent, Edited developer")).toBeVisible();
  expect(documents).toBe(0);
  await page.getByRole("link", { name: "Back to agent" }).click();
  await expect(
    page.getByRole("heading", { name: "Edited developer", exact: true }),
  ).toBeVisible();
});

test("replaces a token, starts and confirms stopping an agent process", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/token");
  await page.getByLabel("New Telegram token").fill("valid-token");
  await page.getByRole("button", { name: "Save token" }).click();
  await expect(page.getByRole("status")).toContainText("Restart this agent");
  await expect(page.getByLabel("New Telegram token")).toHaveValue("");
  await page.getByRole("link", { name: "Back to channels" }).click();
  await expect(page).toHaveURL("/agents/dev/channels");
  await openAgentSection(page, "Overview");
  await expect(
    page.getByRole("heading", { name: "Agent Host stopped." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start agent" }).click();
  await expect(
    page.getByRole("heading", { name: "Agent Host running." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Stop agent…" }).click();
  await expect(
    page.getByRole("heading", { name: "Stop Developer?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm stop" }).click();
  await expect(
    page.getByRole("heading", { name: "Agent Host stopped." }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Agent stopped. Files and history were kept.",
  );
});

for (const deleteData of [false, true])
  test(`deletes with explicit confirmation and deleteData=${deleteData}`, async ({
    page,
  }) => {
    await login(page);
    await page.goto("/agents/dev/delete");
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    await expect(
      page.getByText(
        "The Telegram bot can be revoked separately in BotFather.",
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    if (deleteData) await page.getByRole("checkbox").check();
    const sent = page.waitForRequest((request) =>
      request.url().endsWith("/api/agents/dev/delete"),
    );
    await page
      .getByRole("button", {
        name: deleteData
          ? "Delete agent and its data"
          : "Delete agent, keep its data",
      })
      .click();
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
    page.getByText("Could not update this view (Overview).", { exact: false }),
  ).toBeVisible({ timeout: 8000 });
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry loading Overview" }).click();
  await expect(
    page.getByText("Could not update this view (Overview).", { exact: false }),
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

test("uses Material screen gutters and navigation modes at the width boundaries", async ({
  page,
}) => {
  const shell = page.locator('[data-ui="panel-shell"]');
  const banner = page.getByRole("banner");
  const main = page.getByRole("main");
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  const agentNav = page.getByRole("navigation", { name: "Agent navigation" });

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/login");
  await expect(shell).toHaveCSS("margin-inline-start", "16px");
  await expect(shell).toHaveCSS("margin-inline-end", "16px");
  await expect(
    page.getByRole("heading", { name: "Your agent workspace." }),
  ).toBeInViewport();
  await login(page);
  await page.goto("/agents/dev/settings");
  await expect(agentNav).toBeVisible();

  for (const width of [375, 599, 600, 839, 840, 1199, 1200]) {
    await page.setViewportSize({ width, height: 800 });
    const gutter = width < 600 ? 16 : 24;
    const paneGap = width < 600 ? 16 : 24;
    const contentStart = width < 840 ? gutter : gutter + 160 + paneGap;
    await expect(shell).toHaveCSS("margin-inline-start", `${contentStart}px`);
    await expect(shell).toHaveCSS("margin-inline-end", `${gutter}px`);
    if (width < 840) {
      await expect(banner).toHaveCSS("width", `${width}px`);
      await expect(banner).toHaveCSS("padding-inline-start", `${gutter}px`);
    } else await expect(banner).toHaveCount(0);

    if (width < 600) {
      await expect(mainNav).toHaveCount(0);
      await menu.click();
      await expect(menu).toHaveAttribute("aria-expanded", "true");
    } else {
      await expect(menu).toHaveCount(0);
    }

    const card = page.locator("[data-page-card]");
    const directory = card.locator('[data-ui="agent-header"]');
    const [navBox, shellBox, cardBox, directoryBox, agentBox, mainBox] =
      await Promise.all(
        [mainNav, shell, card, directory, agentNav, main].map((element) =>
          element.boundingBox(),
        ),
      );
    if (
      !navBox ||
      !shellBox ||
      !cardBox ||
      !directoryBox ||
      !agentBox ||
      !mainBox
    )
      throw new Error("Expected visible panel panes");
    expect(shellBox.x).toBeCloseTo(contentStart);
    expect(shellBox.x + shellBox.width).toBeCloseTo(width - gutter);
    if (width < 840) {
      expect(cardBox.y - (navBox.y + navBox.height)).toBeCloseTo(paneGap);
      expect(agentBox.y - (directoryBox.y + directoryBox.height)).toBeCloseTo(
        paneGap,
      );
      expect(mainBox.y - (agentBox.y + agentBox.height)).toBeCloseTo(paneGap);
      await expect(agentNav.locator("summary")).toBeVisible();
    } else {
      expect(cardBox.x - (navBox.x + navBox.width)).toBeCloseTo(paneGap);
      expect(agentBox.x - (mainBox.x + mainBox.width)).toBeCloseTo(paneGap);
      await expect(agentNav.locator("summary")).toBeHidden();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width < 600) await menu.click();
  }
});

test("keeps the floating desktop sidebar fixed with Sign out below Settings", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await login(page);
  await page.goto("/agents/dev/channels");
  await expect(
    page.getByRole("region", { name: "Discord connection" }),
  ).toBeVisible();
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  const home = sidebar.getByRole("link", { name: "Nimbot home" });
  const settings = sidebar.getByRole("link", { name: "Settings", exact: true });
  const signOut = sidebar.getByRole("button", { name: "Sign out" });
  await expect(home).toBeVisible();
  await expect(sidebar).toHaveCSS("position", "fixed");
  await expect(sidebar).toHaveCSS("border-radius", "24px");
  const multicolorGlow =
    /^radial-gradient\(circle.*(?:radial-gradient\(\d+% \d+%.*){3}linear-gradient/;
  await expect(sidebar).toHaveCSS("background-image", multicolorGlow);
  await sidebar.screenshot({ path: info.outputPath("sidebar-expanded.png") });
  const initial = (await sidebar.boundingBox())!;
  expect(initial.x).toBe(24);
  expect(initial.y).toBe(16);
  expect(initial.height).toBe(608);
  const settingsBox = (await settings.boundingBox())!;
  const signOutBox = (await signOut.boundingBox())!;
  expect(signOutBox.y - settingsBox.y - settingsBox.height).toBe(8);
  expect(signOutBox.y + signOutBox.height).toBe(607);

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  expect(await sidebar.boundingBox()).toEqual(initial);
  expect(await settings.boundingBox()).toEqual(settingsBox);
  expect(await signOut.boundingBox()).toEqual(signOutBox);

  await sidebar.getByRole("button", { name: "Hide labels" }).click();
  await expect(sidebar).toHaveCSS("width", "64px");
  await expect(sidebar).toHaveCSS("background-image", multicolorGlow);
  await expect(home).toBeVisible();
  await sidebar.screenshot({ path: info.outputPath("sidebar-collapsed.png") });
  await settings.click();
  await expect(settings).toHaveAttribute("aria-current", "page");

  await page.setViewportSize({ width: 1280, height: 320 });
  await signOut.focus();
  await expect(signOut).toBeInViewport();
  await page.setViewportSize({ width: 839, height: 640 });
  await expect(
    page.getByRole("banner").getByRole("link", { name: "Nimbot home" }),
  ).toBeVisible();
  await expect(sidebar).toHaveCSS("position", "static");
  await expect(sidebar).toHaveCSS("background-image", "none");
  await expect(signOut).toHaveCount(0);
  await expect(
    page.getByRole("banner").getByRole("button", { name: "Sign out" }),
  ).toBeVisible();
});

test("caps the dashboard width on a wide screen", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 920 });
  await login(page);
  await expect(page.locator("[data-page-card]")).toHaveCSS("width", "1200px");
});

test("mirrors panel rails, popovers, and the switch in RTL", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await login(page);
  await page.goto("/agents/dev/settings");
  await page.evaluate(() => (document.documentElement.dir = "rtl"));

  const shell = page.locator('[data-ui="panel-shell"]');
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  const agentNav = page.getByRole("navigation", { name: "Agent navigation" });
  const main = page.getByRole("main");
  await expect(agentNav).toBeVisible();
  const [shellBox, mainNavBox, agentNavBox, mainBox] = await Promise.all(
    [shell, mainNav, agentNav, main].map((element) => element.boundingBox()),
  );
  if (!shellBox || !mainNavBox || !agentNavBox || !mainBox)
    throw new Error("Expected visible RTL panel panes");
  expect(shellBox.x).toBeCloseTo(24);
  expect(mainNavBox.x + mainNavBox.width).toBeCloseTo(1176);
  expect(mainBox.x - (agentNavBox.x + agentNavBox.width)).toBeCloseTo(24);

  const switcher = page.getByLabel("Switch agent, Developer");
  await switcher.press("Enter");
  const popover = page.locator(
    '[data-ui="agent-switcher"] [data-ui="agent-header-popover"]',
  );
  await expect(popover).toBeVisible();
  const [switcherBox, popoverBox] = await Promise.all([
    switcher.boundingBox(),
    popover.boundingBox(),
  ]);
  if (!switcherBox || !popoverBox)
    throw new Error("Expected an open agent switcher");
  expect(popoverBox.x).toBeCloseTo(switcherBox.x);
  await switcher.press("Escape");
  await expect(popover).toBeHidden();

  await page.goto("/mcp/new");
  await page.evaluate(() => (document.documentElement.dir = "rtl"));
  const toggle = page.getByLabel("Enable integration");
  await expect(toggle).toBeVisible();
  await toggle.check();
  await expect(toggle).toBeChecked();
  const thumbTranslate = () =>
    page
      .locator('[data-ui="switch-track"]')
      .evaluate((element) => getComputedStyle(element, "::after").translate);
  await expect.poll(thumbTranslate).toBe("-16px");
  await page.evaluate(() => (document.documentElement.dir = "ltr"));
  await expect.poll(thumbTranslate).toBe("16px");
});

test("moves between agent pages with an expandable main navigation", async ({
  page,
  request,
}, info) => {
  await request.post("/__test/agent/research");
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  const agents = mainNav.getByRole("link", { name: "Agents", exact: true });
  const label = agents.getByText("Agents", { exact: true });
  const showLabels = mainNav.getByRole("button", { name: "Show labels" });
  const hideLabels = mainNav.getByRole("button", { name: "Hide labels" });
  await expect(agents).toHaveAttribute("aria-current", "page");
  await expect(hideLabels).toHaveAttribute("aria-expanded", "true");
  await expect(label).toBeVisible();
  const [toggleIcon, linkIcon] = await Promise.all(
    [hideLabels, agents].map((item) =>
      item.locator('[data-ui="icon"]').boundingBox(),
    ),
  );
  if (!toggleIcon || !linkIcon) throw new Error("Expected navigation icons");
  expect(toggleIcon.x).toBe(linkIcon.x);
  await hideLabels.click();
  await expect(showLabels).toHaveCSS("justify-content", "center");
  await expect(label).toBeHidden();
  await showLabels.focus();
  await page.keyboard.press("Tab");
  await expect(agents).toBeFocused();
  await expect(label).toBeVisible();
  await page.reload();
  await expect(showLabels).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Shift+Tab");
  await showLabels.focus();
  await page.keyboard.press("Space");
  await expect(hideLabels).toHaveAttribute("aria-expanded", "true");
  await expect(label).toBeVisible();

  const agentNav = page.getByRole("navigation", { name: "Agent navigation" });
  await expect(agentNav).toHaveCount(0);
  await page
    .getByRole("link", { name: "Open Developer settings", exact: true })
    .click();
  await expect(agents).toHaveAttribute("aria-current", "location");
  await expect(hideLabels).toBeVisible();
  await expect(
    agentNav.getByRole("link", { name: "Agent settings" }),
  ).toHaveAttribute("aria-current", "page");
  const memory = agentNav.getByRole("link", { name: "Memory" });
  await openAgentSection(page, "Memory");
  await expect(memory).toHaveAttribute("aria-current", "page");
  await openAgentSection(page, "Schedules");
  await expect(
    agentNav.getByRole("link", { name: "Schedules" }),
  ).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(memory).toHaveAttribute("aria-current", "page");

  await agents.click();
  await page
    .getByRole("link", { name: "Open Researcher settings", exact: true })
    .click();
  await expect(memory).toHaveAttribute("href", "/agents/research/memory");
  await expect(agentNav.locator('a[href^="/agents/dev/"]')).toHaveCount(0);

  for (const width of [840, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const expanded of [true, false]) {
      await expect(expanded ? hideLabels : showLabels).toHaveAttribute(
        "aria-expanded",
        String(expanded),
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      const bounds = await agents.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      await (expanded ? hideLabels : showLabels).click();
    }
  }

  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const menu = page.getByRole("button", { name: "Menu" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(mainNav).toHaveCount(0);
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(
      mainNav.getByRole("link", { name: "Agents", exact: true }),
    ).toBeVisible();
    await expect(label).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    const bounds = await agents.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: info.outputPath(`navigation-${width}-open.png`),
    });
    await agents.click();
    await expect(mainNav).toHaveCount(0);
  }
});

test("aligns the agent directory and sections inside the desktop page card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await login(page);
  await page.goto("/agents/dev/setup");
  await expect(page.getByRole("banner")).toHaveCount(0);
  const layout = page.locator("[data-page-card]");
  const directory = layout.locator('[data-ui="agent-header"]');
  await expect(
    layout.getByRole("navigation", { name: "Agent navigation" }),
  ).toBeVisible();
  await expect(layout.getByRole("main")).toBeVisible();
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });

  for (const [direction, expanded] of [
    ["ltr", true],
    ["ltr", false],
    ["rtl", false],
  ] as const) {
    if (!expanded && direction === "ltr")
      await sidebar.getByRole("button", { name: "Hide labels" }).click();
    await page.evaluate(
      (dir) => (document.documentElement.dir = dir),
      direction,
    );
    const [directoryBox, layoutBox] = await Promise.all(
      [directory, layout].map((element) => element.boundingBox()),
    );
    if (!directoryBox || !layoutBox)
      throw new Error("Expected visible header and page content");
    expect(layoutBox.width).toBe(1200);
    expect(directoryBox.width).toBeCloseTo(layoutBox.width - 50);
    expect(directoryBox.x).toBeCloseTo(layoutBox.x + 25);
  }
});

test("switches agents from a deep link", async ({ page, request }) => {
  const researchId = `agent-${"a".repeat(32)}`;
  await request.post(`/__test/agent/${researchId}`);
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const directory = await response.json();
    const research = directory.agents.find(
      (agent: { id: string }) => agent.id === researchId,
    );
    research.botUsername = null;
    await route.fulfill({ response, json: directory });
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await login(page);
  await page.goto("/agents/dev/access");
  const header = page.locator('[data-ui="agent-header"]');
  const switcher = header.getByLabel("Switch agent, Developer");
  const research = header.getByRole("link", { name: /^Researcher/ });
  await switcher.focus();
  await page.keyboard.press("Enter");
  await expect(research).toHaveAttribute(
    "href",
    `/agents/${researchId}/access`,
  );
  const identifier = research.getByText(researchId, { exact: true });
  await expect(identifier).toHaveAttribute("title", researchId);
  await expect(identifier).toHaveCSS("text-overflow", "ellipsis");
  await expect(identifier).toHaveCSS("white-space", "nowrap");
  expect(
    await identifier.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await research.focus();
  await page.keyboard.press("Escape");
  await expect(research).toBeHidden();
  await expect(switcher).toBeFocused();
  await page.keyboard.press("Enter");
  await research.click();
  await expect(page).toHaveURL(`/agents/${researchId}/access`);
  await expect(header.getByLabel("Switch agent, Researcher")).toBeVisible();
});

test("searches configuration options and opens the exact section", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await login(page);
  const search = page.getByRole("searchbox", { name: "Search options" });
  const results = page.getByRole("region", { name: "Matching options" });
  await search.fill("no matching setting");
  await expect(results.getByRole("status")).toHaveText("No matching options.");
  await search.fill("  ThEmE  ");
  const appearance = results.getByRole("link", { name: /Appearance/ });
  await expect(appearance).toHaveAttribute(
    "href",
    "/settings#panel-appearance",
  );
  await expect(
    page.getByRole("link", { name: "Open Developer settings", exact: true }),
  ).toBeAttached();
  await search.press("ArrowDown");
  await expect(appearance).toBeFocused();
  await appearance.press("Escape");
  await expect(results).toBeHidden();
  await expect(search).toBeFocused();
  await search.fill("appearance");
  await search.press("Tab");
  await expect(appearance).toBeFocused();
  await appearance.press("Shift+Tab");
  await expect(search).toBeFocused();
  await search.press("Enter");
  await expect(page).toHaveURL("/settings#panel-appearance");
  const appearanceControl = page.getByRole("combobox", { name: "Appearance" });
  await expect(appearanceControl).toBeFocused();
  await expect(search).toHaveValue("");

  const zone = page.getByRole("textbox", { name: "Schedule time zone" });
  await zone.fill("Europe/Paris");
  await search.fill("TIME   ZONE");
  await results.getByRole("link", { name: /Schedule time zone/ }).click();
  await expect(page).toHaveURL("/settings#schedule-default-zone");
  await expect(zone).toBeFocused();
  await expect(zone).toHaveValue("Europe/Paris");
  await page.goBack();
  await expect(appearanceControl).toBeFocused();
  await page.goForward();
  await expect(zone).toBeFocused();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL("/");

  await search.fill("aNtHrOpIc");
  await results.getByRole("link", { name: /Anthropic/ }).click();
  await expect(page).toHaveURL("/providers#provider-anthropic");
  await expect(page.getByRole("heading", { name: "Anthropic" })).toBeFocused();

  await page.goto("/agents/dev/setup");
  await search.fill("channels");
  const telegram = results
    .getByRole("group", { name: "Developer", exact: true })
    .getByRole("link", { name: "Telegram connection", exact: true });
  await expect(telegram).toHaveAttribute(
    "href",
    "/agents/dev/channels#telegram-connection",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath("option-search-320.png") });
  await telegram.click();
  await expect(page).toHaveURL("/agents/dev/channels#telegram-connection");
  const heading = page.getByRole("heading", { name: "Telegram connection" });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await page.reload();
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
});

test("groups global option search by agent and opens either Telegram section", async ({
  page,
  request,
}, info) => {
  await request.post("/__test/agent/research");
  await page.setViewportSize({ width: 320, height: 800 });
  await login(page);
  const detailRequests: string[] = [];
  page.on("request", (sent) => {
    const { pathname } = new URL(sent.url());
    if (/^\/api\/agents\/[^/]+$/.test(pathname)) detailRequests.push(pathname);
  });
  const search = page.getByRole("searchbox", { name: "Search options" });
  const results = page.getByRole("region", { name: "Matching options" });
  const groups = results.getByRole("group");
  const telegram = (agent: string) =>
    results
      .getByRole("group", { name: agent, exact: true })
      .getByRole("link", { name: "Telegram connection", exact: true });

  await search.fill("mcp");
  await expect(groups).toHaveCount(3);
  await expect(groups.first()).toHaveAttribute("aria-label", "Installation");
  await search.fill("telegram");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute("aria-label", "Developer");
  await expect(groups.nth(1)).toHaveAttribute("aria-label", "Researcher");
  for (const [name, id] of [
    ["Developer", "dev"],
    ["Researcher", "research"],
  ] as const) {
    await expect(telegram(name)).toHaveAttribute(
      "href",
      `/agents/${id}/channels#telegram-connection`,
    );
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: info.outputPath("grouped-option-search-320.png"),
  });
  await search.press("ArrowDown");
  await expect(telegram("Developer")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(telegram("Researcher")).toBeFocused();
  expect(detailRequests).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/agents/research/channels#telegram-connection");
  const heading = page.getByRole("heading", {
    name: "Telegram connection",
    exact: true,
  });
  await expect(heading).toBeFocused();

  await search.fill("developer telegram");
  await expect(groups).toHaveCount(1);
  await telegram("Developer").click();
  await expect(page).toHaveURL("/agents/dev/channels#telegram-connection");
  await expect(heading).toBeFocused();
  expect(detailRequests).toContain("/api/agents/research");
  expect(detailRequests).toContain("/api/agents/dev");

  await request.post("/__test/agent/research-copy");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeFocused();
  await search.fill("researcher telegram");
  await expect(groups).toHaveCount(2);
  await expect(telegram("Researcher (research)")).toBeVisible();
  await expect(telegram("Researcher (research-copy)")).toBeVisible();
});

test("keeps available search results while the agent directory loads or fails", async ({
  page,
}) => {
  await login(page);
  let releaseDirectory!: () => void;
  const initialDirectory = new Promise<void>((resolve) => {
    releaseDirectory = resolve;
  });
  let failDirectory = true;
  await page.route("**/api/status", async (route) => {
    await initialDirectory;
    if (failDirectory) await route.fulfill({ status: 503 });
    else await route.continue();
  });
  await page.goto("/providers");
  const heading = page.getByRole("heading", {
    name: "AI providers",
    exact: true,
  });
  await expect(heading).toBeFocused();
  const search = page.getByRole("searchbox", { name: "Search options" });
  const results = page.getByRole("region", { name: "Matching options" });
  const status = results.getByRole("status");
  const retry = results.getByRole("button", { name: "Retry loading agents" });
  await search.fill("appearance");
  const appearance = results.getByRole("link", { name: /Appearance/ });
  await expect(status).toHaveText("Loading agents…");
  await expect(appearance).toBeVisible();
  releaseDirectory();
  await expect(status).toHaveText("Could not load the latest agent list.");
  await expect(appearance).toBeVisible();

  await search.fill("telegram");
  failDirectory = false;
  await retry.click();
  const telegram = results.getByRole("link", { name: "Telegram connection" });
  await expect(telegram).toBeVisible();
  await expect(search).toBeFocused();

  await heading.focus();
  failDirectory = true;
  await search.focus();
  await expect(status).toHaveText("Could not load the latest agent list.");
  await expect(telegram).toBeVisible();
});

test("keeps capability-gated links out of both navigation bars", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({
      response,
      json: {
        ...session,
        capabilities: {
          createAgent: false,
          mcp: false,
          scheduleSettings: false,
        },
      },
    });
  });
  await page.route("**/api/agents/dev", async (route) => {
    const response = await route.fetch();
    const agent = await response.json();
    await route.fulfill({
      response,
      json: { ...agent, capabilities: { ...agent.capabilities, edit: false } },
    });
  });
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: {
        ...status,
        agents: status.agents.map((agent: { id: string }) => ({
          ...agent,
          optionCapabilities: {
            edit: false,
            discord: false,
          },
        })),
      },
    });
  });
  await page.goto("/agents/dev/setup");
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(
    mainNav
      .getByRole("link")
      .filter({ hasNot: page.locator("[data-ui=wordmark-text]") }),
  ).toHaveText(["Agents", "Settings"]);
  const agentNav = page.getByRole("navigation", { name: "Agent navigation" });
  await expect(agentNav.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(
    agentNav.getByText("Agent settings", { exact: true }),
  ).toHaveCount(0);
  const search = page.getByRole("searchbox", { name: "Search options" });
  const results = page.getByRole("region", { name: "Matching options" });
  for (const query of [
    "schedule time zone",
    "agent settings",
    "mcp",
    "OpenAI",
    "discord",
    "memory tools",
  ]) {
    await search.fill(query);
    await expect(results.getByRole("status")).toHaveText(
      "No matching options.",
    );
  }
  await search.fill("saved notes");
  const notes = results.locator('a[href="/agents/dev/memory#memory-notes"]');
  await expect(notes).toHaveText("Saved notes");
  await notes.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Saved notes" }),
  ).toBeFocused();
  await search.fill("peer access");
  await expect(
    results.getByRole("link", { name: /Other agents/ }),
  ).toHaveAttribute("href", "/agents/dev/access#peer-access");
  await search.press("Escape");
  let mcpRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/agents/dev/mcp")
      mcpRequests++;
  });
  await openAgentSection(page, "Access");
  await expect(
    page.getByRole("region", { name: "Other agents" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "MCP integrations" }),
  ).toHaveCount(0);
  expect(mcpRequests).toBe(0);
  await mainNav.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Schedule time zone" }),
  ).toHaveCount(0);
});

test("keeps the available Access section usable and retries only the failed section", async ({
  page,
}) => {
  await login(page);
  let peerRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/agents/dev/peers")
      peerRequests++;
  });
  await page.route(
    "**/api/agents/dev/mcp",
    (route) =>
      route.fulfill({ status: 503, json: { error: "MCP unavailable" } }),
    { times: 1 },
  );
  await page.goto("/agents/dev/peers");
  await expect(page).toHaveURL("/agents/dev/access");
  const peers = page.getByRole("region", { name: "Other agents" });
  const mcp = page.getByRole("region", { name: "MCP integrations" });
  await expect(peers.getByText(/No grants/)).toBeVisible();
  await expect(mcp.getByRole("status")).toHaveText(
    "MCP integrations unavailable.",
  );
  const retry = mcp.getByRole("button", {
    name: "Retry loading MCP integrations",
  });
  const recovered = page.waitForResponse("**/api/agents/dev/mcp");
  await retry.click();
  expect((await recovered).ok()).toBe(true);
  await expect(retry).toHaveCount(0);
  await expect(peers.getByText(/No grants/)).toBeVisible();
  expect(peerRequests).toBe(1);
});

test("shares the split layout across agent configuration sections", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  for (const [path, regions] of [
    ["access", ["Other agents", "MCP integrations"]],
    ["usage", ["Model", "Provider quota"]],
    ["approvals", ["Rules", "Decision history"]],
    ["memory", ["Saved notes"]],
  ] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/agents/dev/${path}`);
    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of regions) {
        const region = page.getByRole("region", { name, exact: true });
        await expect(region).toBeVisible();
        const card = region.locator(":scope > .panel-card");
        await expect(card).toHaveCSS("background-image", "none");
        const [description, content] = await Promise.all([
          region.locator(".settings-section-description").boundingBox(),
          card.boundingBox(),
        ]);
        if (!description || !content)
          throw new Error(`Expected ${name} content`);
        if (width === 1280) {
          expect(content.y).toBeCloseTo(description.y);
          expect(content.x - description.x - description.width).toBeCloseTo(24);
        } else {
          expect(content.x).toBeCloseTo(description.x);
          expect(content.y - description.y - description.height).toBeCloseTo(
            16,
          );
        }
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      if (width !== 320)
        await page.screenshot({
          path: info.outputPath(`agent-${path}-${width}.png`),
          fullPage: true,
        });
    }
  }
});

test("shows the current agent section and supports keyboard navigation at narrow widths", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/agents/dev/settings");
  const nav = page.getByRole("navigation", { name: "Agent navigation" });
  const summary = nav.locator("summary");
  const edit = nav.getByRole("link", { name: "Agent settings" });
  await expect(summary).toHaveText("Agent sections · Agent settings");
  await expect(edit).toBeHidden();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(edit).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "Overview" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();
  await expect(summary).toBeFocused();
  await openAgentSection(page, "Schedules");
  await expect(page).toHaveURL(/\/agents\/dev\/schedules$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(summary).toHaveText("Agent sections · Schedules");
  await expect(nav.getByRole("link", { name: "Schedules" })).toBeHidden();
  await page.goBack();
  await expect(summary).toHaveText("Agent sections · Agent settings");
  await page.setViewportSize({ width: 839, height: 800 });
  await expect(summary).toBeVisible();
  await page.setViewportSize({ width: 840, height: 800 });
  await expect(summary).toBeHidden();
  await expect(edit).toHaveAttribute("aria-current", "page");
});

test("organizes agent overview sections in rows and stacks their contents on phones", async ({
  page,
}, info) => {
  await login(page);
  await page.route("**/api/agents/dev", async (route) => {
    const response = await route.fetch();
    const agent = await response.json();
    await route.fulfill({ response, json: { ...agent, providerChecks: [] } });
  });
  await page.goto("/agents/dev/setup");
  const globalNav = page.getByRole("navigation", { name: "Main navigation" });
  const panel = page.locator('[data-ui="page-layout"]');
  const agentNav = panel.getByRole("navigation", { name: "Agent navigation" });
  const main = panel.getByRole("main");
  const overview = main.locator('[data-ui="agent-overview"]');
  const host = overview.getByRole("region", { name: /Agent Host stopped/ });
  const provider = overview.getByRole("region", { name: "AI provider status" });
  const danger = overview.getByRole("region", { name: "Danger zone" });

  await expect(main.getByRole("heading", { level: 1 })).toHaveCSS(
    "position",
    "absolute",
  );
  await expect(overview.getByRole("region")).toHaveCount(3);
  await expect(
    overview.getByRole("region", { name: /connection/i }),
  ).toHaveCount(0);
  await expect(panel).toHaveCSS("background-image", /^radial-gradient\(circle/);
  await expect(panel).toHaveCSS("border-width", "1px");
  await expect(host).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(host.locator(".panel-card")).toHaveCSS(
    "background-image",
    "none",
  );
  await expect(danger.locator(".panel-card")).toHaveCSS(
    "background-image",
    "none",
  );

  for (const width of [1280, 1920, 840, 320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    if (width < 840) {
      await expect(
        page.getByRole("button", { name: "Menu", exact: true }),
      ).toBeVisible();
    } else {
      await expect(page.getByRole("banner")).toHaveCount(0);
    }
    if (width === 1920) await expect(panel).toHaveCSS("width", "1200px");
    const [agentBox, mainBox] = await Promise.all([
      agentNav.boundingBox(),
      main.boundingBox(),
    ]);
    if (!agentBox || !mainBox)
      throw new Error("Expected the agent navigation and content");

    let previousBottom = mainBox.y;
    for (const region of [host, provider, danger]) {
      const [row, description, content] = await Promise.all([
        region.boundingBox(),
        region.locator(".settings-section-description").boundingBox(),
        region.locator(".panel-card").boundingBox(),
      ]);
      if (!row || !description || !content)
        throw new Error("Expected a description and content in every row");
      expect(row.y).toBeGreaterThanOrEqual(previousBottom);
      previousBottom = row.y + row.height;
      if (width >= 1280) {
        expect(content.y).toBeCloseTo(description.y);
        expect(content.x - (description.x + description.width)).toBeCloseTo(24);
      } else {
        expect(content.y - (description.y + description.height)).toBeCloseTo(
          16,
        );
        expect(content.x).toBeCloseTo(description.x);
      }
    }

    if (width >= 840) {
      const globalBox = await globalNav.boundingBox();
      if (!globalBox) throw new Error("Expected global navigation");
      expect(globalBox.x + globalBox.width).toBeLessThan(mainBox.x);
      expect(agentBox.x - (mainBox.x + mainBox.width)).toBeCloseTo(24);
      await expect(main).toHaveCSS("border-inline-end-width", "1px");
      await expect(agentNav.getByRole("link")).toHaveCount(11);
      await expect(
        agentNav.getByRole("link", { name: "Rules", exact: true }),
      ).toBeVisible();
      const selected = agentNav.getByRole("link", { name: "Overview" });
      await expect(selected).toHaveAttribute("aria-current", "page");
      const mainLink = globalNav.getByRole("link", {
        name: "Agents",
        exact: true,
      });
      for (const link of [mainLink, selected])
        await expect(link).toHaveCSS("border-top-left-radius", "16px");
      await expect(selected.locator('[data-ui="icon"]')).toHaveCSS(
        "mask-image",
        /url\("data:image\/svg\+xml/,
      );
    } else {
      expect(mainBox.y - (agentBox.y + agentBox.height)).toBeCloseTo(16);
      await expect(agentNav).toHaveCSS("border-block-end-width", "1px");
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width === 1280 || width === 375)
      await page.screenshot({
        path: info.outputPath(`agent-overview-${width}.png`),
        fullPage: true,
      });
  }
});

test("opens Channels from agent navigation and loads it directly", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await page.goto("/agents/dev/setup");
  await openAgentSection(page, "Channels");
  await expect(page).toHaveURL("/agents/dev/channels");
  const heading = page.getByRole("heading", { name: "Channels for Developer" });
  await expect(heading).toBeFocused();
  await expect(
    page
      .getByRole("navigation", { name: "Agent navigation" })
      .getByRole("link", { name: "Channels" }),
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(heading).toBeVisible();
  const discord = page.getByRole("region", { name: "Discord connection" });
  await discord
    .getByLabel("Owner's Discord user ID")
    .fill("987654321098765432");
  await discord.getByLabel("Discord bot token").fill("valid-discord-token");
  await discord.getByRole("button", { name: "Connect Discord" }).click();
  await expect(
    discord.getByRole("heading", { name: "Discord connection" }),
  ).toBeFocused();
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const name of ["Telegram connection", "Discord connection"]) {
      const region = page.getByRole("region", { name });
      await expect(region).toBeVisible();
      const [description, card] = await Promise.all([
        region.locator(".settings-section-description").boundingBox(),
        region.locator(".panel-card").boundingBox(),
      ]);
      if (!description || !card) throw new Error(`Expected ${name} controls`);
      if (width === 1280)
        expect(card.x - description.x - description.width).toBeCloseTo(24);
      else expect(card.y - description.y - description.height).toBeCloseTo(16);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.locator('[data-ui="agent-channels"]').screenshot({
      path: info.outputPath(`configured-channels-${width}.png`),
    });
  }
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
  await openAgentSection(page, "Agent settings");
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

test("follows system appearance and remembers explicit theme choices", async ({
  page,
}, info) => {
  const root = page.locator("html");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/login");
  await expect(page.getByLabel("Administrator password")).toBeVisible();
  const card = page.locator("[data-page-card]");
  await expect(card).toHaveCount(0);
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveCSS("color-scheme", "light");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(241, 244, 249)",
  );
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath("sign-in-light-320.png") });

  await login(page);
  await page.goto("/settings");
  await expect(card.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    card.getByRole("searchbox", { name: "Search options" }),
  ).toBeVisible();
  const appearance = card.getByRole("combobox", { name: "Appearance" });
  const timeZone = card.getByRole("textbox", { name: "Schedule time zone" });
  await expect(appearance).toHaveValue("system");
  await expect(timeZone).not.toHaveValue("");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath("settings-light-320.png") });

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await timeZone.fill("Europe/Paris");
  await appearance.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(appearance).toHaveValue("light");
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(timeZone).toHaveValue("Europe/Paris");
  await page.reload();
  await expect(appearance).toHaveValue("light");
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(timeZone).not.toHaveValue("Europe/Paris");
  await page.goto("/login");
  await expect(page.getByLabel("Administrator password")).toBeVisible();
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.goto("/settings");
  await appearance.selectOption("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(appearance).toHaveValue("dark");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.evaluate(() =>
    localStorage.setItem("nimbot-panel-appearance", "invalid"),
  );
  await page.reload();
  await expect(appearance).toHaveValue("system");
  await expect(root).toHaveAttribute("data-theme", "light");
});

test("can change appearance for the visit when browser storage is blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Browser storage unavailable", "SecurityError");
      },
    });
  });
  await login(page);
  await page.goto("/settings");
  const appearance = page.getByRole("combobox", { name: "Appearance" });
  const root = page.locator("html");
  await expect(appearance).toHaveValue("system");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await appearance.selectOption("light");
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.getByRole("link", { name: "AI providers" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
});

for (const theme of ["dark", "light"] as const) {
  test(`keeps forms within mobile widths and retains readable theme contrast in ${theme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await login(page);
    await page.goto("/agents/dev/settings");
    await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth), {
          message: `page fits after navigation reflows at ${width}px`,
        })
        .toBeLessThanOrEqual(width);
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
      const fields = [
        "body",
        'section[aria-label="Agent settings"]',
        'section[aria-label="Agent settings"] button[type="submit"]',
        "input#name",
      ].map((selector) => {
        const element = document.querySelector(selector)!;
        const style = getComputedStyle(element);
        return {
          selector,
          text: ratio(style.color, style.backgroundColor),
          border:
            selector === "input#name"
              ? ratio(style.borderColor, style.backgroundColor)
              : undefined,
        };
      });
      const root = getComputedStyle(document.documentElement);
      const contrast = (foreground: string, background: string) =>
        ratio(
          root.getPropertyValue(foreground),
          root.getPropertyValue(background),
        );
      const palette = [
        ...["--glow-blue", "--glow-teal", "--glow-violet"].flatMap(
          (background) => [
            { foreground: "--color-base-content", background, minimum: 4.5 },
            { foreground: "--color-muted", background, minimum: 4.5 },
            { foreground: "--color-primary", background, minimum: 3 },
          ],
        ),
        ...["--chart-green", "--chart-amber", "--chart-magenta"].map(
          (foreground) => ({
            foreground,
            background: "--color-base-100",
            minimum: 3,
          }),
        ),
      ].map(({ foreground, background, minimum }) => ({
        pair: `${foreground} on ${background}`,
        contrast: contrast(foreground, background),
        minimum,
      }));
      return { fields, palette };
    });
    for (const item of ratios.fields) {
      expect(
        item.text,
        `${item.selector} text contrast`,
      ).toBeGreaterThanOrEqual(4.5);
      if (item.border !== undefined)
        expect(item.border).toBeGreaterThanOrEqual(3);
    }
    for (const item of ratios.palette)
      expect(item.contrast, item.pair).toBeGreaterThanOrEqual(item.minimum);
    await test.info().attach("theme-contrast", {
      body: JSON.stringify(ratios),
      contentType: "application/json",
    });
    await page.screenshot({
      path: test.info().outputPath(`panel-${theme}-mobile.png`),
      fullPage: true,
    });
  });
}

const dashboardUsage = {
  days: [
    { day: "2026-11-21", costUsd: 0.125, tokens: 40, tasks: 1 },
    { day: "2026-11-22", costUsd: 0.375, tokens: 80, tasks: 3 },
  ],
  models: [
    {
      providerId: "opencode",
      modelId: "fixture",
      costUsd: 0.5,
      tokens: 120,
      tasks: 4,
    },
  ],
  missingCost: 0,
  quotas: [
    {
      providerId: "opencode",
      window: "Go monthly",
      remainingPercent: 42,
      resetsAt: Date.UTC(2026, 11, 1),
      exhausted: false,
    },
  ],
  hourly: Array.from({ length: 48 }, (_, index) => ({
    hour: new Date(Date.UTC(2026, 10, 21, index)).toISOString(),
    costUsd: index === 47 ? 0.5 : index === 10 ? 0.25 : 0,
    tokens: 0,
  })),
};

test("draws rounded model usage segments with gaps and keeps single-model rings whole", async ({
  page,
}, info) => {
  let models = [76_000, 54_000, 38_000, 22_000, 0].map((tokens, index) => ({
    providerId: "opencode",
    modelId: `model-${index}`,
    costUsd: 0,
    tokens,
    tasks: 1,
  }));
  await page.route("**/api/usage/overview*", (route) =>
    route.fulfill({
      json: {
        ...dashboardUsage,
        days: [{ day: "2026-11-22", costUsd: 0, tokens: 190_000, tasks: 5 }],
        models,
      },
    }),
  );
  await login(page);
  await expect(page.getByRole("button", { name: "30 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("img", {
      name: "Reported cost per day for the last 30 days",
    }),
  ).toBeVisible();
  const modelUsage = page.getByRole("region", { name: "Models", exact: true });
  const donut = modelUsage.locator('[data-ui="usage-donut"]');
  const segments = donut.locator("circle[data-slice]");
  const track = donut.locator("circle[data-track]");
  await expect(segments).toHaveCount(4);
  await expect(track).toHaveCount(0);
  await expect(segments.first()).toHaveCSS("stroke-linecap", "round");
  await expect(segments.first()).toHaveCSS("stroke-width", "13px");
  await expect(segments.first()).not.toHaveCSS("stroke-dasharray", "none");
  expect(
    Number(await segments.first().getAttribute("stroke-dashoffset")),
  ).toBeLessThan(-6.5);
  await expect(donut.getByText("tokens", { exact: true })).toBeVisible();
  await donut.screenshot({ path: info.outputPath("rounded-usage-donut.png") });

  models = models.slice(0, 1);
  await page.getByRole("button", { name: "7 days" }).click();
  await expect(segments).toHaveCount(1);
  await expect(segments.first()).toHaveCSS("stroke-dasharray", "none");

  models = models.map((model) => ({ ...model, tokens: 0 }));
  await page.getByRole("button", { name: "30 days" }).click();
  await expect(segments).toHaveCount(0);
  await expect(track).toHaveCount(1);
});

test("filters and searches agent cards, opens settings with Enter, and reconciles removed agents", async ({
  page,
  request,
}) => {
  await request.post("/__test/agent/research");
  let agents = [
    {
      id: "dev",
      name: "Developer",
      optionCapabilities: { edit: true, discord: true },
      botUsername: "developer_bot",
      provisioning: "ready",
      process: { state: "running", desiredState: "running" },
      botConnection: { status: "polling" },
      setupAccess: { bot: "linked", owner: "verified" },
    },
    {
      id: "writer",
      name: "Writer",
      optionCapabilities: { edit: false, discord: true },
      botUsername: "writer_bot",
      provisioning: "pending",
      process: { state: "stopped", desiredState: "stopped" },
      botConnection: { status: "not_started" },
      setupAccess: { bot: "linked", owner: "pending" },
    },
    {
      id: "research",
      name: "Analyst",
      optionCapabilities: { edit: false, discord: true },
      botUsername: "findings_bot",
      provisioning: "failed",
      process: { state: "running", desiredState: "running" },
      botConnection: { status: "blocked" },
      setupAccess: { bot: "linked", owner: "pending" },
    },
  ];
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { agents } }),
  );
  await page.route("**/api/usage/overview*", (route) =>
    route.fulfill({ json: dashboardUsage }),
  );
  await login(page);
  const filters = page.getByRole("group", { name: "Filter agents" });
  await expect(
    filters.getByRole("button", { name: /All agents/ }),
  ).toContainText("3");
  await expect(filters.getByRole("button", { name: /Running/ })).toContainText(
    "2",
  );
  await expect(
    filters.getByRole("button", { name: /Needs attention/ }),
  ).toContainText("1");
  const usage = page.getByLabel("Usage", { exact: true });
  await expect(usage.getByText("$0.50")).toBeVisible();
  const trend = page.getByLabel("Last 24 hours", { exact: true });
  await expect(trend.getByText("$0.50", { exact: true })).toBeVisible();
  await expect(
    trend.getByRole("img", {
      name: "Cumulative reported cost over the last 24 hours",
    }),
  ).toHaveCSS("height", "96px");
  const quota = page.getByLabel("Quota left", { exact: true });
  await expect(quota.getByText("opencode")).toBeVisible();
  await expect(quota.getByText("Go monthly")).toBeVisible();
  const track = quota.locator("circle[data-track]");
  await expect(track).toHaveCount(1);
  await expect(track).not.toHaveAttribute("stroke-dasharray", /./);
  await expect(trend.getByText(/\+\$0\.25\s+\(100%\)/)).toBeVisible();
  await expect(
    page.getByLabel("Models", { exact: true }).getByText("fixture"),
  ).toBeVisible();
  const cards = page.getByRole("list", { name: "Agent workspaces" });
  const developer = cards.getByRole("link", {
    name: "Open Developer settings",
  });
  const research = cards.getByRole("link", { name: "Open Analyst overview" });
  const writer = cards.getByRole("link", { name: "Open Writer overview" });
  const search = page.getByRole("searchbox", { name: "Search agents" });
  await filters.getByRole("button", { name: /Needs attention/ }).click();
  await expect(research).toHaveAttribute("href", "/agents/research/setup");
  await expect(research.getByText("Overview", { exact: true })).toBeVisible();
  await expect(research.getByText("Running", { exact: true })).toHaveAttribute(
    "data-tone",
    "good",
  );
  await expect(research.getByText("Telegram blocked")).toBeVisible();
  await expect(research).toHaveAccessibleDescription(
    "Running Telegram blocked @findings_bot",
  );
  await expect(developer).toHaveCount(0);
  await search.fill("writer");
  await expect(
    page.getByRole("heading", { name: "No matching agents." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(writer).toBeVisible();
  await expect(developer.getByText("Settings", { exact: true })).toBeVisible();
  await filters.getByRole("button", { name: /Needs attention/ }).focus();
  await page.keyboard.press("Tab");
  await expect(developer).toBeFocused();
  await expect(developer).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/agents/dev/settings");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Developer",
  );
  await page.goBack();
  await expect(writer).toBeVisible();
  agents = agents
    .filter((agent) => agent.id !== "writer")
    .map((agent) =>
      agent.id === "research"
        ? { ...agent, botConnection: { status: "failed" } }
        : agent,
    );
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(writer).toHaveCount(0);
  await expect(research.getByText("Telegram connection failed")).toBeVisible();
  await search.fill("@FINDINGS_BOT");
  await expect(research).toBeVisible();
  await expect(developer).toHaveCount(0);
  await search.fill("dev");
  await expect(developer).toBeVisible();
  await expect(research).toHaveCount(0);
  await search.fill("research");
  await expect(research).toBeVisible();
  await research.click();
  await expect(page).toHaveURL("/agents/research/setup");
  await expect(
    page.getByRole("heading", { name: "Researcher", exact: true }),
  ).toBeVisible();
});

test("renders the reference-inspired dashboard across screen sizes without external assets", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
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
  await page.route("**/api/usage/overview*", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).searchParams.get("days") === "30"
          ? {
              days: Array.from({ length: 30 }, (_, index) => ({
                day: new Date(Date.UTC(2026, 10, index + 1))
                  .toISOString()
                  .slice(0, 10),
                costUsd: 0,
                tokens: 0,
                tasks: 0,
              })),
              models: [],
              quotas: [],
              hourly: [],
              missingCost: 0,
            }
          : dashboardUsage,
    }),
  );
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        agents: [
          {
            id: "dev",
            name: "Developer",
            optionCapabilities: { edit: true, discord: true },
            botUsername: "nimbot_developer_bot",
            provisioning: "ready",
            process: { state: "running", desiredState: "running" },
            botConnection: { status: "polling" },
            setupAccess: { bot: "linked", owner: "verified" },
          },
          {
            id: "research",
            name: "Research assistant",
            botUsername: "nimbot_research_bot",
            provisioning: "ready",
            process: { state: "running", desiredState: "running" },
            botConnection: { status: "polling" },
            setupAccess: { bot: "linked", owner: "pending" },
          },
          {
            id: "writer",
            name: "Content studio",
            botUsername: "nimbot_content_bot",
            provisioning: "provisioning",
            process: { state: "starting", desiredState: "running" },
            botConnection: { status: "connecting" },
            setupAccess: { bot: "linked", owner: "pending" },
          },
          {
            id: "ops",
            name: "Operations",
            botUsername: "nimbot_ops_bot",
            provisioning: "failed",
            process: { state: "failed", desiredState: "running" },
            botConnection: { status: "blocked" },
            setupAccess: { bot: "linked", owner: "pending" },
          },
          {
            id: "personal",
            name: "Personal assistant with a long workspace name and AReallyLongUnbrokenWordThatNeedsToWrapOnSmallScreens",
            botUsername: null,
            provisioning: "ready",
            process: { state: "running", desiredState: "running" },
            botConnection: { status: "polling" },
            setupAccess: { bot: "linked", owner: "verified" },
          },
        ],
      },
    }),
  );
  await login(page);
  const dashboard = page.locator("[data-page-card]");
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  expect((await dashboard.boundingBox())?.y).toBe(
    (await sidebar.boundingBox())?.y,
  );
  await page.getByRole("button", { name: "7 days" }).click();
  const refreshIcon = page
    .getByRole("button", { name: "Refresh status" })
    .locator('[data-ui="icon"]');
  await expect(refreshIcon).toBeVisible();
  await expect(refreshIcon).toHaveCSS(
    "mask-image",
    /url\("data:image\/svg\+xml/,
  );
  await expect(refreshIcon).toHaveCSS("width", "18px");
  await expect(refreshIcon).toHaveAttribute("aria-hidden", "true");
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      document.fonts.check('400 14px "Manrope Variable"'),
    ),
  ).toBe(true);
  const models = page.getByRole("region", { name: "Models" });
  await expect(models.getByText("fixture", { exact: true })).toBeVisible();
  const switcher = dashboard.getByLabel(/^Switch agent/);
  const search = dashboard.getByRole("searchbox", { name: "Search options" });
  await expect(switcher).toHaveCount(0);
  await expect(search).toBeVisible();
  await expect(page.getByRole("banner")).toHaveCount(0);

  const fleetSearch = page.getByRole("searchbox", {
    name: "Search agents",
  });
  const fleet = dashboard
    .locator('[data-ui="surface"]')
    .filter({ has: fleetSearch });
  const usage = dashboard.getByRole("region", { name: "Usage", exact: true });
  const fleetToolbar = fleet.locator('[data-ui="workspace-heading"]');
  await expect(
    fleetToolbar.getByRole("searchbox", { name: "Search agents" }),
  ).toBeVisible();
  await expect(
    fleetToolbar.getByRole("group", { name: "Filter agents" }),
  ).toBeVisible();
  await expect(
    fleet.getByRole("heading", { name: /Agent workspaces/ }),
  ).toHaveCount(0);
  const cards = fleet.getByRole("list", { name: "Agent workspaces" });
  const developer = cards.getByRole("link", {
    name: "Open Developer settings",
  });
  const personal = cards.getByRole("link", {
    name: /^Open Personal assistant/,
  });
  const avatar = developer.locator(".agent-avatar");
  const name = developer.getByText("Developer", { exact: true });
  const running = developer.getByText("Running", { exact: true });
  const identifier = developer.getByText("@nimbot_developer_bot", {
    exact: true,
  });
  await expect(identifier).toHaveAttribute("title", "@nimbot_developer_bot");
  await expect(identifier).toHaveCSS("text-overflow", "ellipsis");
  await expect(identifier).toHaveCSS("white-space", "nowrap");
  await expect(personal.locator("small")).toHaveCount(0);
  await expect(running).toHaveAttribute("data-tone", "good");
  await expect(developer).toHaveAccessibleDescription(
    "Running @nimbot_developer_bot",
  );
  await expect(developer).toHaveAttribute("href", "/agents/dev/settings");
  const plainSurfaces = [
    ...["Usage", "Models", "Quota left", "Last 24 hours"].map((name) =>
      dashboard.getByRole("region", { name, exact: true }),
    ),
    fleet,
  ];
  await expect(dashboard.locator('[data-line="current"]')).toHaveCSS(
    "filter",
    "none",
  );
  await expect(dashboard.locator('[data-ui="trend-dot"]')).toHaveCSS(
    "box-shadow",
    "none",
  );

  const range = page.getByRole("group", { name: "Usage range" });
  for (const state of ["populated", "empty"]) {
    if (state === "empty") {
      await range.getByRole("button", { name: "7 days" }).focus();
      await page.keyboard.press("Tab");
      const longerRange = range.getByRole("button", { name: "30 days" });
      await expect(longerRange).toBeFocused();
      await expect(longerRange).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Enter");
      await expect(longerRange).toHaveAttribute("aria-pressed", "true");
      await expect(
        models.getByText("No model usage in the last 30 days."),
      ).toBeVisible();
    }
    for (const theme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(dashboard).toHaveCSS(
        "background-image",
        /^radial-gradient\(circle.*radial-gradient\(45% 55% at 0% 30%,.*radial-gradient\(45% 55% at 100% 25%,.*radial-gradient\(50% 50% at 65% 75%,/,
      );
      for (const surface of plainSurfaces) {
        await expect(surface).toHaveCSS("background-image", "none");
        await expect(surface).toHaveCSS("box-shadow", "none");
      }
      for (const width of [1440, 768, 375, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        const banner = page.getByRole("banner");
        if (width < 840) {
          await expect(banner).toBeVisible();
          await expect(
            banner.getByRole("button", { name: "Menu", exact: true }),
          ).toHaveCount(width < 600 ? 1 : 0);
        } else {
          await expect(banner).toHaveCount(0);
        }
        const title = dashboard.getByRole("heading", { name: "Your agents." });
        const [titleBox, fleetBox, usageBox, searchBox] = await Promise.all(
          [title, fleet, usage, search].map((element) =>
            element.evaluate((node) => {
              const { top, bottom } = node.getBoundingClientRect();
              return {
                y: top + window.scrollY,
                bottom: bottom + window.scrollY,
              };
            }),
          ),
        );
        expect(fleetBox.y).toBeGreaterThan(titleBox.bottom);
        expect(usageBox.y).toBeGreaterThan(fleetBox.bottom);
        expect(searchBox.bottom).toBeLessThan(titleBox.y);
        await expect(switcher).toHaveCount(0);
        await expect
          .poll(
            () => page.evaluate(() => document.documentElement.scrollWidth),
            {
              message: `overflow in the ${theme} ${state} dashboard at ${width}px`,
            },
          )
          .toBeLessThanOrEqual(width);
        if (state === "empty") {
          const bars = dashboard
            .getByRole("img", {
              name: /reported cost per day for the last 30 days/i,
            })
            .locator('[data-ui="usage-bar-track"]');
          await expect(bars).toHaveCount(30);
          expect((await bars.last().boundingBox())?.width).toBeGreaterThan(4);
        }
        await expect(running).toBeVisible();
        await expect(running).toHaveCSS(
          "color",
          theme === "dark" ? "rgb(179, 255, 57)" : "rgb(39, 99, 49)",
        );
        await expect(developer).toBeVisible();
        const second = cards.getByRole("link", {
          name: /^Open Research assistant/,
        });
        const firstCardBox = (await developer.boundingBox())!;
        const secondCardBox = (await second.boundingBox())!;
        if (width === 320 || width === 375) {
          expect(secondCardBox.x).toBe(firstCardBox.x);
          expect(secondCardBox.y).toBeGreaterThan(firstCardBox.y);
          await expect(avatar).toHaveCSS("width", "36px");
          const avatarBox = (await avatar.boundingBox())!;
          const nameBox = (await name.boundingBox())!;
          expect(nameBox.x).toBeGreaterThan(avatarBox.x + avatarBox.width);
        } else {
          expect(secondCardBox.x).toBeGreaterThan(firstCardBox.x);
          expect(secondCardBox.y).toBe(firstCardBox.y);
          await expect(avatar).toHaveCSS("width", "54px");
        }
        const prefix = theme === "light" ? "dashboard-light" : "dashboard";
        await page.screenshot({
          path: info.outputPath(`${prefix}-${state}-${width}.png`),
          fullPage: true,
        });
      }
    }
  }
  expect(violations).toEqual([]);
  expect(external).toEqual([]);
});

test("starts a failed Host from the saved agent page", async ({
  page,
  request,
}) => {
  await login(page);
  await request.post("/__test/fail/dev");
  await page.goto("/agents/dev/setup");
  await expect(
    page.getByRole("heading", { name: "Agent Host failed." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start agent" }).click();
  await expect(
    page.getByRole("heading", { name: "Agent Host running." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry setup" })).toHaveCount(
    0,
  );
});

test("configures, replaces, and removes Discord without changing Telegram", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("link", { name: "Open Developer settings", exact: true })
    .click();
  await openAgentSection(page, "Channels");
  const discord = page.getByRole("region", { name: "Discord connection" });
  await expect(discord.getByText("Discord is not configured.")).toBeVisible();
  const owner = discord.getByLabel("Owner's Discord user ID");
  const token = discord.getByLabel("Discord bot token", { exact: true });
  const connect = discord.getByRole("button", { name: "Connect Discord" });
  await owner.fill("18446744073709551616");
  await token.fill("invalid-token");
  await connect.click();
  await expect(discord.getByRole("alert")).toContainText(
    "personal Discord profile",
  );
  await expect(owner).toBeFocused();
  await expect(owner).toHaveAttribute("aria-invalid", "true");
  await expect(token).toHaveValue("invalid-token");
  await owner.fill("987654321098765432");
  await expect(discord.getByRole("alert")).toHaveCount(0);
  await connect.click();
  await expect(discord.getByRole("alert")).toContainText(
    "Discord rejected the bot token",
  );
  await expect(token).toBeFocused();
  await expect(token).toHaveValue("");
  await expect(owner).toHaveValue("987654321098765432");

  await page.route(
    "**/api/agents/dev/discord",
    async (route) => {
      await route.fulfill({
        status: 503,
        json: { error: "Could not save Discord. Wait a moment and try again." },
      });
    },
    { times: 1 },
  );
  await token.fill("valid-discord-token");
  await discord.getByRole("button", { name: "Show value" }).click();
  await expect(token).toHaveAttribute("type", "text");
  await connect.click();
  await expect(page.getByRole("alert")).toContainText("Could not save Discord");
  await expect(token).toHaveValue("valid-discord-token");
  await expect(token).toHaveAttribute("type", "password");
  await connect.click();
  await expect(
    discord.getByText("notification_bot", { exact: true }),
  ).toBeVisible();
  await expect(
    discord.getByLabel("Discord bot token", { exact: true }),
  ).toBeHidden();
  await page.reload();
  const credentials = discord.getByText("Change Discord credentials", {
    exact: true,
  });
  await credentials.focus();
  await page.keyboard.press("Enter");
  await expect(
    discord.getByLabel("Discord bot token", { exact: true }),
  ).toHaveValue("");
  await expect(discord.getByLabel("Owner's Discord user ID")).toHaveValue(
    "987654321098765432",
  );
  await discord
    .getByLabel("Owner's Discord user ID")
    .fill("876543210987654321");
  await page
    .getByRole("button", { name: "Refresh channel status", exact: true })
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
  const disconnect = discord.getByText("Disconnect Discord", { exact: true });
  await expect(discord.getByLabel("Type dev to confirm removal")).toBeHidden();
  await disconnect.focus();
  await page.keyboard.press("Enter");
  await expect(
    discord.getByRole("button", { name: "Remove Discord connection" }),
  ).toBeDisabled();
  await discord.getByLabel("Type dev to confirm removal").fill("dev");
  await discord
    .getByRole("button", { name: "Remove Discord connection" })
    .click();
  await expect(discord.getByText("Discord is not configured.")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Telegram connection" })
      .getByText("@developer_bot", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Channels for Developer", exact: true }),
  ).toBeVisible();
});

test("sends Discord tests and reuses the request when checking uncertain delivery", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/channels");
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
  request,
}, info) => {
  await request.post("/__test/agent/research");
  await login(page);
  await page
    .getByRole("link", { name: "Open Developer settings", exact: true })
    .click();
  await openAgentSection(page, "Channels");
  const discord = page.getByRole("region", { name: "Discord connection" });
  const telegram = page.getByRole("region", { name: "Telegram connection" });
  await expect(discord.getByText("Discord is not configured.")).toBeVisible();
  await expect(
    telegram.getByRole("link", { name: "Open chat in Telegram" }),
  ).toHaveAttribute("href", "https://t.me/developer_bot");
  await page.getByLabel("Owner's Discord user ID").fill("987654321098765432");
  await page
    .getByLabel("Discord bot token", { exact: true })
    .fill("valid-discord-token");
  await page.getByRole("button", { name: "Connect Discord" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Waiting for a reply", {
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
    .getByRole("button", { name: "Refresh channel status", exact: true })
    .click();
  await expect(
    page.getByText("Connection failed", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Discord connection" })
      .getByText("Linked", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Connection", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Telegram connection" })
      .getByText("@developer_bot", { exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/agents/dev");
  await page.getByRole("button", { name: "Refresh channel status" }).click();
  await expect(
    discord.getByText("notification_bot", { exact: true }),
  ).toBeVisible();
  await expect(discord.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    discord.getByText("Waiting for a reply", { exact: true }),
  ).toBeVisible();
  await request.post("/__test/discord-owner/dev");
  await page.getByRole("button", { name: "Refresh channel status" }).click();
  await expect(discord.getByText("Linked", { exact: true })).toBeVisible();
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await discord.screenshot({
      path: info.outputPath(`discord-channels-${width}.png`),
    });
  }
  await page.goto("/");
  await page
    .getByRole("link", { name: "Open Researcher settings", exact: true })
    .click();
  await openAgentSection(page, "Channels");
  await expect(discord.getByText("Discord is not configured.")).toBeVisible();
  await expect(discord.getByText("Owner DM", { exact: true })).toHaveCount(0);
});

test("creates a webhook schedule, shows credentials, triggers it, and revokes its token", async ({
  page,
  request,
}, info) => {
  await openSchedules(page);
  await request.post("/__test/owner/dev");
  await scheduleDraft(page, "Deployment webhook");
  await page.getByLabel("Activation", { exact: true }).selectOption("webhook");
  await expect(page.getByLabel("Time of day")).not.toBeVisible();
  await expect(page.getByLabel("Time zone", { exact: true })).not.toBeVisible();
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  const card = page.getByRole("region", {
    name: "Deployment webhook",
    exact: true,
  });
  await expect(card).toContainText("Waiting for webhook");
  await card.getByRole("button", { name: "Show webhook details" }).focus();
  await page.keyboard.press("Enter");
  const url = await card
    .getByLabel("Webhook URL", { exact: true })
    .inputValue();
  const tokenField = card.getByLabel("Bearer token", { exact: true });
  const token = await tokenField.inputValue();
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`webhook-${width}.png`),
      fullPage: true,
    });
  }
  const response = await request.post(url, {
    headers: { Authorization: `Bearer ${token}` },
    data: { event: "deploy" },
  });
  expect(response.status()).toBe(202);
  await page
    .getByRole("button", { name: "Refresh schedules", exact: true })
    .click();
  await expect(card.locator("dd").last()).toHaveText("Completed");
  await card.getByRole("button", { name: "Pause", exact: true }).click();
  expect(
    (
      await request.post(url, { headers: { Authorization: `Bearer ${token}` } })
    ).status(),
  ).toBe(409);
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Regenerate token" }).click();
  await expect(tokenField).not.toHaveValue(token);
  expect(
    (
      await request.post(url, { headers: { Authorization: `Bearer ${token}` } })
    ).status(),
  ).toBe(401);
  await card.getByRole("button", { name: "Hide webhook details" }).click();
  await expect(tokenField).not.toBeVisible();
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Activation", { exact: true })).toHaveValue(
    "webhook",
  );
  await expect(page.getByLabel("Time zone", { exact: true })).not.toBeVisible();
});

for (const deploymentMode of ["native", "docker"] as const)
  test(`manages ${deploymentMode} processes with interruption confirmations`, async ({
    page,
    request,
  }) => {
    if (deploymentMode === "native") await request.post("/__test/native");
    await login(page);
    await expect(
      page
        .getByRole("banner")
        .getByText(/^(Native development|Docker deployment)$/),
    ).toHaveCount(0);
    await page.goto("/agents/dev/setup");
    await expect(
      page.getByRole("heading", { name: "Agent Host stopped." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start container" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Start agent", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Agent Host running." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start agent", exact: true }),
    ).toHaveCount(0);
    const stop = page.getByRole("link", { name: "Stop agent…" });
    const restart = page.getByRole("link", { name: "Restart agent…" });
    const refresh = page.getByRole("button", { name: "Refresh status" });
    for (const [control, color] of [
      [stop, "rgb(255, 168, 177)"],
      [restart, "rgb(255, 207, 136)"],
      [refresh, "rgb(186, 207, 253)"],
    ] as const) {
      await expect(control).toHaveCSS("color", color);
      await expect(control).toHaveCSS("background-color", /^color\(srgb /);
      await expect(control).toHaveCSS("background-image", "none");
      await expect(control).toHaveCSS("box-shadow", "none");
    }
    await page.getByRole("link", { name: "Restart agent…" }).click();
    await expect(
      page.getByRole("heading", { name: "Restart Developer?" }),
    ).toBeFocused();
    await expect(
      page.getByText("Active work may be interrupted.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Agent Host running." }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/nimbot-${deploymentMode}-running.png`,
      fullPage: true,
    });
    await page.getByRole("link", { name: "Restart agent…" }).click();
    await expect(
      page.getByRole("heading", { name: "Restart Developer?" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Confirm restart" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Agent Host running." }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Stop agent…" }).click();
    await page.getByRole("button", { name: "Confirm stop" }).click();
    await expect(
      page.getByRole("heading", { name: "Agent Host stopped." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start agent", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Delete agent…" }).click();
    const purge = page.getByRole("checkbox", { name: /agent data directory/ });
    await expect(purge).not.toBeChecked();
    await expect(purge).toHaveAccessibleName(
      /AI conversation history.*browser profile/,
    );
  });

for (const deploymentMode of ["native", "docker"] as const)
  test(`uses process language on narrow screens in ${deploymentMode} mode`, async ({
    page,
    request,
  }) => {
    if (deploymentMode === "native") await request.post("/__test/native");
    await page.setViewportSize({ width: 320, height: 900 });
    await login(page);
    await expect(page.getByLabel("Shared installation trust")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.goto("/agents/new");
    await expect(
      page.getByText(/Connect Telegram or Discord from Channels/),
    ).toBeVisible();
    await expect(page.getByText(/its container is prepared/)).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/nimbot-${deploymentMode}-create-mobile.png`,
      fullPage: true,
    });
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/agents/dev/setup");
      await expect(
        page.getByRole("heading", { name: "Agent Host stopped." }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });

test("creates and edits cron schedules with local previews and inline errors", async ({
  page,
}) => {
  await openSchedules(page);
  await scheduleDraft(page, "Weekday cron");
  const activation = page.getByLabel("Activation", { exact: true });
  await activation.selectOption("cron");
  await page.getByLabel("Time zone", { exact: true }).fill("UTC");
  const expression = page.getByRole("textbox", {
    name: "Cron expression",
    exact: true,
  });
  await expect(expression).toHaveAttribute("maxlength", "100");
  await expression.fill("0 9 * * mon-fri");
  await activation.selectOption("daily");
  await activation.selectOption("cron");
  await expect(expression).toHaveValue("0 9 * * mon-fri");
  const preview = page.getByRole("region", { name: "Next runs" });
  await expect(preview.getByRole("listitem")).toHaveCount(5);
  await expect(preview.getByRole("listitem").first()).toContainText(
    "9:00 AM (UTC)",
  );
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  const card = page.getByRole("region", { name: "Weekday cron", exact: true });
  await expect(card).toContainText("Cron 0 9 * * MON-FRI");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(expression).toHaveValue("0 9 * * MON-FRI");
  await expression.fill("*/5 * * * *");
  await expression.press("Tab");
  await expect(expression).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Cron minutes must be at least 15 minutes apart.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expression.fill("30 9 * * MON-FRI");
  await expect(expression).toHaveAttribute("aria-invalid", "false");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(card).toContainText("Cron 30 9 * * MON-FRI");
});

test("opens saved execution details and shows delivery separately on a narrow panel", async ({
  page,
  request,
}) => {
  const seeded = await request.post("/__test/execution");
  const { id } = await seeded.json();
  await page.setViewportSize({ width: 375, height: 800 });
  await login(page);
  await page.goto("/agents/dev/setup");
  await openAgentSection(page, "Executions");
  const link = page.getByRole("link", { name: `View execution ${id}` });
  const row = page.getByRole("row").filter({ has: link });
  await expect(row.getByText("Completed", { exact: true })).toBeVisible();
  await expect(row.getByText("Unconfirmed", { exact: true })).toBeVisible();
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Execution details" }),
  ).toBeFocused();
  await expect(page.getByText("Summarize the report.")).toBeVisible();
  await expect(
    page.getByText("The report contains <strong>three findings</strong>."),
  ).toBeVisible();
  await expect(
    page.getByText("Telegram · Unconfirmed", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBe(375);
  await page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/agents/dev/executions/${id}`) &&
      response.ok(),
  );
  await expect(
    page.getByRole("heading", { name: "Execution details" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to executions" }).click();
  await expect(link).toBeVisible();
});

test("manages shared and per-agent Markdown rules independently", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Rules", exact: true })
    .click();
  await expect(page).toHaveURL("/rules");
  const markdown = page.getByRole("textbox", { name: "Markdown" });
  const save = page.getByRole("button", { name: "Save rule" });
  const add = async (body: string) => {
    await page.getByRole("button", { name: "Add rule" }).click();
    await expect(markdown).toBeFocused();
    await markdown.fill(body);
    await save.click();
    await expect(page.getByText("Rule saved.")).toBeVisible();
  };
  await add("\n## Style\n\n- Use short paragraphs.");
  await add("- Verify quotations.");
  await page.getByRole("button", { name: "Edit rule ## Style" }).click();
  await expect(markdown).toHaveValue("\n## Style\n\n- Use short paragraphs.");
  await markdown.fill("## Writing style\n\n- Use plain English.");
  await save.click();
  await expect(page.getByText("Rule saved.")).toBeVisible();
  await page.reload();
  await page.getByText("## Writing style", { exact: true }).click();
  await expect(
    page.getByText("- Use plain English.", { exact: false }),
  ).toBeVisible();

  await page.goto("/agents/dev/setup");
  await openAgentSection(page, "Rules");
  await expect(page).toHaveURL("/agents/dev/rules");
  const inherited = page.getByRole("region", { name: "Shared rules" });
  await expect(
    inherited.getByText("## Writing style", { exact: true }),
  ).toBeVisible();
  await expect(inherited.getByRole("button")).toHaveCount(0);
  await add("- Use Spanish.");
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("- Use Spanish.");
    await dialog.accept();
  });
  await page
    .getByRole("button", { name: "Remove rule - Use Spanish." })
    .click();
  await expect(page.getByText("Rule removed.")).toBeVisible();
  await expect(
    inherited.getByText("## Writing style", { exact: true }),
  ).toBeVisible();

  await inherited.getByRole("link", { name: "Manage shared rules" }).click();
  await expect(page).toHaveURL("/rules");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Remove rule - Verify quotations." })
    .click();
  await expect(page.getByText("Rule removed.")).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("## Writing style", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("- Verify quotations.", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search options" }).fill("rules");
  const results = page.getByRole("region", { name: "Matching options" });
  await expect(results.locator('a[href="/rules#rules"]')).toBeVisible();
  await expect(
    results.locator('a[href="/agents/dev/rules#rules"]'),
  ).toBeVisible();
});
