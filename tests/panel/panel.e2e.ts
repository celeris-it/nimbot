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
  const link = nav.locator("a").and(nav.getByText(name, { exact: true }));
  await expect(link).toBeAttached();
  if (!(await link.isVisible()))
    await nav.getByLabel("More agent options").click();
  await link.click();
}

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
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
    page.getByRole("link", { name: "Open Overview to start it" }),
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
  const model = page.getByLabel("Model for new turns");
  await expect(model).toHaveValue("automatic");
  await model.selectOption({ label: "Fixture model (opencode/fixture/model)" });
  await page.getByRole("button", { name: "Save model" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Model saved for new turns." }),
  ).toBeVisible();
  await page.reload();
  await expect(model).toHaveValue(
    JSON.stringify(["opencode", "fixture/model"]),
  );
  await expect(page.getByText("Queue paused for quota")).toBeVisible({
    timeout: 12_000,
  });
  await expect(
    page.getByText("Console monthly", { exact: true }),
  ).toBeVisible();
  await model.selectOption("automatic");
  await page.getByRole("button", { name: "Save model" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Model saved for new turns." }),
  ).toBeVisible();
  await page.reload();
  await expect(model).toHaveValue("automatic");
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
  ).toHaveCSS("text-align", "right");
  await expect(table.getByRole("cell", { name: /1,500/ })).toHaveCSS(
    "text-align",
    "right",
  );
  const partial = table.getByRole("row", { name: /Completed/ });
  await expect(partial.getByText("Partial usage")).toBeVisible();
  await expect(partial.getByText("Nightly workspace summary")).toBeVisible();
  const failed = table.getByRole("row", { name: /Failed/ });
  await expect(failed.getByText("Unavailable", { exact: true })).toHaveCount(3);
  const history = page.locator(".table-panel");
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
  await page.getByLabel("Enable integration").check();
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
  await openAgentSection(page, "MCP access");
  await expect(
    page.getByRole("heading", { name: "MCP access for Developer" }),
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
  await openAgentSection(page, "Agent access");
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
  await page
    .getByRole("button", { name: "Delete note Research notes" })
    .click();
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
  await page.getByRole("link", { name: "Manage", exact: true }).click();
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

test("edits the global schedule time zone and prefills new schedules", async ({
  page,
}) => {
  await openSchedules(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const zone = page.getByLabel("Schedule time zone");
  await expect(zone).toHaveValue("UTC");
  await zone.fill("Europe/Madrid");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText(
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
  await scheduleDraft(page, "A".repeat(60));
  await page
    .getByLabel("Time zone", { exact: true })
    .fill("America/Argentina/Catamarca");
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  const card = page.getByRole("region", { name: "A".repeat(60), exact: true });
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

test("manages global API keys with keyboard navigation and blank secret fields", async ({
  page,
  request,
}) => {
  await openProviders(page);
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
  await disconnect.click();
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
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    if (width !== 375)
      await page
        .getByRole("region", { name: "OpenAI", exact: true })
        .screenshot({
          path: test.info().outputPath(`provider-authorization-${width}.png`),
        });
  }
  await page.reload();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await request.post("/__test/providers/completed");
  await expect(
    page.getByText("ChatGPT login completed for all agents."),
  ).toBeVisible();
  await expect(
    page.getByText("Configured — ChatGPT device login"),
  ).toBeVisible();
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

test("shows global provider busy and unavailable states", async ({
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
  await request.post("/__test/providers/offline");
  await page.goto("/agents/dev/providers");
  await expect(
    page.getByText("Provider settings unavailable.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh provider settings" }),
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
  await openAgentSection(page, "Agent settings");
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
  const discord = page.getByRole("region", { name: "Discord connection" });
  await discord
    .getByLabel("Owner's Discord user ID")
    .fill("987654321098765432");
  await discord.getByLabel("Discord bot token").fill("valid-discord-token");
  await discord.getByRole("button", { name: "Connect Discord" }).click();
  await expect(
    discord.getByText("notification_bot", { exact: true }),
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
  const telegram = page.getByRole("region", { name: "Telegram connection" });
  await telegram.getByLabel("Owner's Telegram ID").fill("42");
  const token = telegram.getByLabel("Telegram bot token");
  await token.fill("wrong-token");
  await telegram.getByRole("button", { name: "Connect Telegram" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not connect Telegram",
  );
  await expect(telegram.getByLabel("Owner's Telegram ID")).toHaveValue("42");
  await expect(token).toHaveValue("");
  await token.fill("valid-token");
  await telegram.getByRole("button", { name: "Connect Telegram" }).click();
  await expect(
    telegram.getByText("@developer_bot", { exact: true }),
  ).toBeVisible();
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
  await page.getByRole("link", { name: "Back to agent" }).click();
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
  await hideLabels.click();
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
  await page.getByRole("button", { name: "Select Developer" }).click();
  await page.getByRole("link", { name: "Manage", exact: true }).click();
  await expect(agents).toHaveAttribute("aria-current", "location");
  await expect(hideLabels).toBeVisible();
  await expect(
    agentNav.getByRole("link", { name: "Overview" }),
  ).toHaveAttribute("aria-current", "page");
  const memory = agentNav.getByRole("link", { name: "Memory" });
  await openAgentSection(page, "Memory");
  await expect(memory).toHaveAttribute("aria-current", "page");
  await openAgentSection(page, "Schedules");
  await expect(agentNav.locator('a[aria-current="page"]')).toHaveText(
    "Schedules",
  );
  await page.goBack();
  await expect(memory).toHaveAttribute("aria-current", "page");

  await agents.click();
  await page.getByRole("button", { name: "Select Researcher" }).click();
  await page.getByRole("link", { name: "Manage", exact: true }).click();
  await expect(memory).toHaveAttribute("href", "/agents/research/memory");
  await expect(agentNav.locator('a[href^="/agents/dev/"]')).toHaveCount(0);

  for (const width of [1051, 1280]) {
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
  await page.goto("/agents/dev/setup");
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(mainNav.getByRole("link")).toHaveText(["Agents"]);
  const agentNav = page.getByRole("navigation", { name: "Agent navigation" });
  await expect(agentNav.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(
    agentNav.getByText("Agent settings", { exact: true }),
  ).toHaveCount(0);
  await expect(agentNav.getByText("MCP access", { exact: true })).toHaveCount(
    0,
  );
});

test("keeps the agent top bar on one line and exposes overflow by keyboard", async ({
  page,
}, info) => {
  await login(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/agents/dev/settings");
  const nav = page.getByRole("navigation", { name: "Agent navigation" });
  const overview = nav.getByRole("link", { name: "Overview" });
  const more = nav.getByLabel("More agent options");
  const edit = nav.getByRole("link", { name: "Agent settings" });
  await expect(overview).toBeVisible();
  await expect(more).toHaveText("More · Agent settings");
  await expect(more).toHaveAttribute("data-current", "true");
  expect((await overview.boundingBox())?.y).toBe((await more.boundingBox())?.y);
  await expect(edit).toBeHidden();
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(edit).toHaveAttribute("aria-current", "page");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("agent-navigation-overflow.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Tab");
  const firstOverflowLink = nav
    .locator('[data-ui="agent-nav-options"]')
    .getByRole("link")
    .first();
  await expect(firstOverflowLink).toBeFocused();
  await expect(firstOverflowLink).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await expect(edit).toBeVisible();
  await page
    .getByRole("heading", { name: "Edit agent." })
    .click({ position: { x: 5, y: 5 } });
  await expect(edit).toBeHidden();
  await openAgentSection(page, "Schedules");
  await expect(page).toHaveURL(/\/agents\/dev\/schedules$/);
  await expect(nav.getByRole("link", { name: "Schedules" })).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(
    nav.getByRole("link", { name: "Model and usage" }),
  ).toBeVisible();
});

test("aligns the agent top bar with the logo and uses the wide viewport", async ({
  page,
}, info) => {
  await login(page);
  await page.goto("/agents/dev/setup");
  const header = page.getByRole("banner");
  const logo = header.getByRole("link", { name: "Nimbot home" });
  const agentNav = header.getByRole("navigation", { name: "Agent navigation" });
  const signOut = header.getByRole("button", { name: "Sign out" });
  const main = page.getByRole("main");
  for (const width of [601, 1280, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(agentNav).toBeVisible();
    const [logoBox, navBox, signOutBox, headerBox, mainBox] = await Promise.all(
      [
        logo.boundingBox(),
        agentNav.boundingBox(),
        signOut.boundingBox(),
        header.boundingBox(),
        main.boundingBox(),
      ],
    );
    if (!(logoBox && navBox && signOutBox && headerBox && mainBox))
      throw new Error("Expected visible header and page content");
    const navCenter = navBox.y + navBox.height / 2;
    expect(navCenter).toBeCloseTo(logoBox.y + logoBox.height / 2, 0);
    expect(navCenter).toBeCloseTo(signOutBox.y + signOutBox.height / 2, 0);
    expect(logoBox.x + logoBox.width).toBeLessThan(navBox.x);
    expect(navBox.x + navBox.width).toBeLessThan(signOutBox.x);
    const viewportWidth = await page.evaluate(
      () => document.documentElement.clientWidth,
    );
    expect(viewportWidth - headerBox.x - headerBox.width).toBeLessThanOrEqual(
      56,
    );
    expect(mainBox.x + mainBox.width).toBeCloseTo(
      headerBox.x + headerBox.width,
      0,
    );
  }
  await expect(
    agentNav.getByRole("link", { name: "Agent settings" }),
  ).toBeVisible();
  await expect(agentNav.getByLabel("More agent options")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("wide-agent-header.png") });
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

test("keeps forms within mobile widths and retains readable theme contrast", async ({
  page,
}) => {
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
    return [
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
      process: { state: "running", desiredState: "running" },
      botConnection: { status: "polling" },
      setupAccess: { bot: "linked", owner: "verified" },
    },
    {
      id: "writer",
      name: "Writer",
      botUsername: "writer_bot",
      provisioning: "pending",
      process: { state: "stopped", desiredState: "stopped" },
      botConnection: { status: "not_started" },
      setupAccess: { bot: "linked", owner: "pending" },
    },
    {
      id: "research",
      name: "Research",
      botUsername: "research_bot",
      provisioning: "failed",
      process: { state: "failed", desiredState: "running" },
      botConnection: { status: "blocked" },
      setupAccess: { bot: "linked", owner: "pending" },
    },
  ];
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { agents } }),
  );
  await login(page);
  const overview = page.getByLabel("Agent overview");
  const metric = (label: string) =>
    overview
      .locator('[data-ui="metric"]')
      .filter({ hasText: label })
      .locator(".metric-value");
  await expect(metric("Total agents")).toHaveText("3");
  await expect(metric("Running")).toHaveText("1");
  await expect(metric("Needs attention")).toHaveText("1");
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
            name: "Personal assistant",
            botUsername: "nimbot_personal_bot",
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
  await expect(page.getByText("Connection", { exact: true })).toBeVisible();
  await expect(page.getByText("@developer_bot", { exact: true })).toBeVisible();
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
        .getByText(
          deploymentMode === "native"
            ? "Native development"
            : "Docker deployment",
          { exact: true },
        ),
    ).toBeVisible();
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
      page.getByText(/Connect Telegram or Discord from setup/),
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
