import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});

test.describe("Spanish panel", () => {
  test.use({ locale: "es-AR" });

  test("detects browser language and preserves the sign-in draft when switching", async ({
    page,
  }) => {
    await page.goto("/login");
    const html = page.locator("html");
    const selector = page.locator("#login-language");
    const password = page.locator("#password");
    await expect(html).toHaveAttribute("lang", "es");
    await expect(page.getByRole("combobox", { name: "Idioma" })).toHaveValue(
      "browser",
    );
    await page
      .getByRole("button", { name: "Iniciar sesión en el panel" })
      .click();
    await expect
      .poll(() =>
        password.evaluate((field: HTMLInputElement) => field.validationMessage),
      )
      .toBe("Completa este campo.");
    await password.fill("panel-test-password");
    await selector.focus();
    await selector.selectOption("en");
    await expect(selector).toBeFocused();
    await expect(password).toHaveValue("panel-test-password");
    await expect(html).toHaveAttribute("lang", "en");
    await page.reload();
    await expect(selector).toHaveValue("en");
    await selector.selectOption("browser");
    await expect(html).toHaveAttribute("lang", "es");
    await password.fill("wrong");
    await page
      .getByRole("button", { name: "Iniciar sesión en el panel" })
      .click();
    await expect(page.getByRole("alert")).toHaveText(
      "Contraseña incorrecta. Vuelve a intentarlo.",
    );
    await selector.selectOption("en");
    await expect(page.getByRole("alert")).toHaveText(
      "Incorrect password. Try again.",
    );

    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await selector.selectOption("es");
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
    }
  });

  test("localizes Settings feedback and schedules without changing saved data", async ({
    page,
  }) => {
    await page.goto("/login");
    await page
      .getByLabel("Contraseña de administración")
      .fill("panel-test-password");
    await page
      .getByRole("button", { name: "Iniciar sesión en el panel" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Tus agentes." }),
    ).toBeVisible();
    await page.goto("/settings");
    const selector = page.getByRole("combobox", { name: "Idioma" });
    const zone = page.locator("#schedule-default-zone");
    await expect(zone).toHaveValue("UTC");
    await zone.fill("Not/A_Time_Zone");
    await page.getByRole("button", { name: "Guardar zona horaria" }).click();
    await expect(page.locator("#schedule-default-zone-error")).toHaveText(
      "La zona horaria debe ser un nombre IANA válido.",
    );
    await expect(zone).toBeFocused();
    await selector.selectOption("en");
    await expect(zone).toHaveValue("Not/A_Time_Zone");
    await expect(page.locator("#schedule-default-zone-error")).toHaveText(
      "Time zone must be a valid IANA time zone name.",
    );
    await page.locator("#panel-language").selectOption("es");
    await page.goto("/agents/dev/schedules");
    await page.getByRole("button", { name: "Nueva programación" }).click();
    await page.getByLabel("Nombre de la programación").fill("Resumen");
    await page
      .getByLabel("Instrucciones", { exact: true })
      .fill("Review tasks.");
    const activation = page.getByLabel("Activación", { exact: true });
    await activation.selectOption("cron");
    await page.locator("#schedule-cron").fill("0 24 * * *");
    await page.locator("#schedule-cron").press("Tab");
    await expect(page.locator("#schedule-cron-error")).toHaveText(
      "Campo hora de cron: 24 está fuera del rango 0-23.",
    );
    await activation.selectOption("daily");
    await page
      .getByRole("button", { name: "Crear programación", exact: true })
      .click();
    const schedule = page.getByRole("region", { name: "Resumen", exact: true });
    const time = schedule.locator("time").first();
    await expect(time).toBeVisible();
    const date = await time.getAttribute("datetime");
    expect(date).not.toBeNull();
    const formatted = new Intl.DateTimeFormat("es-419", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(date!));
    await expect(time).toHaveText(`${formatted} (UTC)`);
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("¿Eliminar la programación «Resumen»");
      await dialog.dismiss();
    });
    await schedule
      .getByRole("button", { name: "Eliminar", exact: true })
      .click();
    await expect(schedule).toBeVisible();
  });
});
