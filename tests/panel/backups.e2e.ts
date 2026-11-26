import { expect, test, type Page } from "@playwright/test";
import type { BackupStatus } from "../../apps/server/src/panel/panel-contracts.js";

async function openBackups(page: Page) {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({
      response,
      json: {
        ...session,
        capabilities: { ...session.capabilities, backups: true },
      },
    });
  });
  await page.goto("/login");
  await page.getByLabel("Administrator password").fill("panel-test-password");
  await page.getByRole("button", { name: "Sign in to the panel" }).click();
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeVisible();
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Backups", exact: true }),
  ).toBeVisible();
}

const initialStatus: BackupStatus = {
  maintenance: false,
  maxBytes: 10 * 1024 ** 3,
};

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test("creates and downloads a backup with maintenance feedback", async ({
  page,
}) => {
  let status: BackupStatus = structuredClone(initialStatus);
  await page.route("**/api/backups", (route) =>
    route.fulfill({ json: status }),
  );
  await page.route("**/api/backups/export", (route) => {
    status = {
      ...status,
      maintenance: true,
      operation: {
        id: "export-1",
        kind: "export",
        phase: "archiving",
        status: "running",
      },
    };
    return route.fulfill({ status: 202, json: status.operation });
  });
  await openBackups(page);
  await page.screenshot({
    path: test.info().outputPath("backups-initial.png"),
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Create backup", exact: true })
    .click();
  await expect(
    page.getByText("Creating the backup…", { exact: true }),
  ).toBeVisible();
  expect(
    await page
      .getByText("Creating the backup…", { exact: true })
      .evaluate((element) => element.closest('[aria-busy="true"]') === null),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Create backup", exact: true }),
  ).toBeDisabled();
  await page.route("**/api/settings/schedules", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Nimbot is in maintenance mode." },
    }),
  );
  await page.reload();
  await expect(
    page.getByText("Creating the backup…", { exact: true }),
  ).toBeVisible();
  status = {
    ...initialStatus,
    operation: {
      id: "export-1",
      kind: "export",
      phase: "ready",
      status: "ready",
    },
    download: { id: "export-1", createdAt: "2026-01-01T12:00:00Z" },
  };
  await expect(
    page.getByRole("link", { name: "Download backup" }),
  ).toHaveAttribute("href", "/api/backups/export-1/download");
  await expect(
    page.getByRole("button", { name: "Create backup", exact: true }),
  ).toBeEnabled();
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
});

test("validates before confirming restoration and expires the session", async ({
  page,
}) => {
  let status: BackupStatus = structuredClone(initialStatus);
  let restored = false;
  let receivedUpload = false;
  await page.route("**/api/backups", (route) =>
    route.fulfill(
      restored
        ? { status: 401, json: { error: "Session expired." } }
        : { json: status },
    ),
  );
  await page.route("**/api/backups/upload", (route) => {
    receivedUpload = route.request().postData() === "test archive";
    status = {
      ...initialStatus,
      operation: {
        id: "validation-1",
        kind: "validate",
        phase: "ready",
        status: "ready",
      },
      restore: {
        id: "validation-1",
        manifest: {
          createdAt: "2026-01-01T12:00:00Z",
          buildId: "test-build",
          totalBytes: 1024,
        },
      },
    };
    return route.fulfill({ status: 202, json: status.operation });
  });
  await page.route("**/api/backups/restore", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      id: "validation-1",
      confirm: true,
    });
    restored = true;
    return route.fulfill({ status: 202, json: { id: "restore-1" } });
  });
  await openBackups(page);
  await page.getByLabel("Backup file", { exact: true }).setInputFiles({
    name: "backup.tar.gz",
    mimeType: "application/gzip",
    buffer: Buffer.from("test archive"),
  });
  await page
    .getByRole("button", { name: "Validate backup", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Validated backup" }),
  ).toBeVisible();
  expect(receivedUpload).toBe(true);
  await expect(page.getByText("test-build", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Restore this backup" }).click();
  expect(restored).toBe(false);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Restore this backup" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("localizes backup controls and rejects oversized uploads before sending", async ({
  page,
}) => {
  let uploadRequests = 0;
  await page.route("**/api/backups", (route) =>
    route.fulfill({ json: { ...initialStatus, maxBytes: 1 } }),
  );
  await page.route("**/api/backups/upload", (route) => {
    uploadRequests++;
    return route.fulfill({ status: 500, json: {} });
  });
  await openBackups(page);
  await page.locator("#panel-language").selectOption("es");
  await expect(
    page.getByRole("heading", { name: "Copias de seguridad", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Elegir archivo", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Ningún archivo seleccionado", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Archivo de copia de seguridad", { exact: true })
    .setInputFiles({
      name: "backup.tar.gz",
      mimeType: "application/gzip",
      buffer: Buffer.from("too large"),
    });
  await page
    .getByRole("button", { name: "Validar copia de seguridad", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "La copia seleccionada supera el límite de carga.",
  );
  expect(uploadRequests).toBe(0);
});

test("supports keyboard file selection and explains missing files beside the control", async ({
  page,
}) => {
  await page.route("**/api/backups", (route) =>
    route.fulfill({ json: initialStatus }),
  );
  await openBackups(page);
  const chooseFile = page.getByRole("button", {
    name: "Choose file",
    exact: true,
  });
  const validate = page.getByRole("button", {
    name: "Validate backup",
    exact: true,
  });
  await expect(validate).toBeEnabled();
  await validate.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Choose a backup file before validating.",
  );
  await expect(chooseFile).toBeFocused();
  const chooserEvent = page.waitForEvent("filechooser");
  await chooseFile.press("Enter");
  const chooser = await chooserEvent;
  const filename = `${"nimbot-installation-backup-".repeat(7)}2026-11-26.tar.gz`;
  await chooser.setFiles({
    name: filename,
    mimeType: "application/gzip",
    buffer: Buffer.from("archive"),
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("#backup-file-name")).toHaveText(filename);
  await chooseFile.focus();
  await page.keyboard.press("Tab");
  await expect(validate).toBeFocused();
  await page.keyboard.press("Tab");
  const details = page.getByText("Backup contents and requirements", {
    exact: true,
  });
  await expect(details).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(/Includes files, conversations, private memory/),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Runtime temporary files and engine caches are excluded. Tools may download dependencies again after restoration.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.keyboard.press("Space");
  await expect(
    page.getByText(/Includes files, conversations, private memory/),
  ).toBeHidden();
  for (const appearance of ["dark", "light"]) {
    await page.locator("#panel-appearance").selectOption(appearance);
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`backups-${appearance}-${width}.png`),
        fullPage: true,
      });
    }
  }
});
