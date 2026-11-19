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

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test("selects an agent model and shows its published quota in the panel", async ({
  page,
}) => {
  await login(page);
  await page.goto("/agents/dev/setup");
  await page.getByRole("link", { name: "Model and usage" }).click();
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
  await page.getByRole("link", { name: "MCP access" }).click();
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
  const colors = await page.locator(".alert").evaluate((element) => {
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
  await page.getByRole("link", { name: "Agent access" }).click();
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
  await page.getByRole("link", { name: "Approvals", exact: true }).click();
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
  await page.getByRole("link", { name: "Review memory" }).click();
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
  await page.getByRole("link", { name: "Delegations" }).click();
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
  await page.goto("/agents/dev/setup");
  await page.getByRole("button", { name: "Start container" }).click();
  await page.getByRole("link", { name: "Configure AI providers" }).click();
  await expect(
    page.getByRole("heading", { name: "AI providers for Developer" }),
  ).toBeVisible();
}

async function openSchedules(page: Page) {
  await login(page);
  await page.getByRole("link", { name: "Manage", exact: true }).click();
  await page
    .getByRole("button", { name: "Start container", exact: true })
    .click();
  await page.getByRole("link", { name: "Manage schedules" }).click();
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
  await page.getByLabel("Activation", { exact: true }).selectOption("weekly");
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Friday", { exact: true }).check();
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  card = page.getByRole("region", { name: "Weekly review", exact: true });
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

test("manages per-agent API keys with keyboard navigation and blank secret fields", async ({
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
    "API key saved for this agent.",
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
  await expect(
    page.getByRole("heading", { name: "AI providers for Researcher" }),
  ).toBeVisible();
  await expect(
    openai.getByText("Not configured", { exact: true }),
  ).toBeVisible();
  await key.fill("private-research");
  await openai.getByRole("button", { name: "Save API key" }).click();
  await page.goto("/agents/dev/providers");
  await expect(
    openai.getByText("Configured — API key", { exact: true }),
  ).toBeVisible();
  await openai.getByRole("button", { name: "Disconnect provider" }).click();
  await expect(
    openai.getByText("Not configured", { exact: true }),
  ).toBeVisible();
  await page.goto("/agents/research/providers");
  await expect(
    openai.getByText("Configured — API key", { exact: true }),
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
  await page.reload();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await request.post("/__test/providers/dev/completed");
  await expect(
    page.getByText("ChatGPT login completed for this agent."),
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
    await request.post(`/__test/providers/dev/${state}`);
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

test("shows busy and offline provider states without affecting other agents", async ({
  page,
  request,
}) => {
  await openProviders(page);
  await request.post("/__test/providers/dev/busy");
  await expect(
    page.getByText(
      "Agent is busy. Wait for its task or authentication change to finish.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with ChatGPT" }),
  ).toBeDisabled();
  await request.post("/__test/agent/research");
  await page.goto("/agents/research/providers");
  await expect(
    page.getByRole("button", { name: "Sign in with ChatGPT" }),
  ).toBeEnabled();
  await request.post("/__test/providers/dev/offline");
  await page.goto("/agents/dev/providers");
  await expect(
    page.getByText("Provider settings unavailable.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open agent setup" }),
  ).toHaveAttribute("href", "/agents/dev/setup");
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

test("recovers a missing container and displays Start only after recovery", async ({
  page,
}) => {
  await login(page);
  let recovered = false;
  await page.route("**/api/agents/dev", async (route) => {
    const response = await route.fetch();
    const agent = await response.json();
    await route.fulfill({
      response,
      json: {
        ...agent,
        containerState: recovered ? "stopped" : "missing",
        recovery: recovered ? undefined : { status: "available" },
        capabilities: { ...agent.capabilities, container: recovered },
      },
    });
  });
  await page.route("**/api/agents/dev/recover", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postData() ?? "").toBe("");
    recovered = true;
    await route.fulfill({ json: { agentId: "dev", recovery: "restored" } });
  });
  await page.goto("/agents/dev/setup");
  const start = page.getByRole("button", { name: "Start container" });
  await expect(start).toHaveCount(0);
  await page.getByRole("button", { name: "Recover on this server" }).click();
  await expect(
    page.getByText("Recovery complete. Select Start container to resume work."),
  ).toBeVisible();
  await expect(start).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Recover on this server" }),
  ).toHaveCount(0);
});
