import { expect, test } from "@playwright/test";

for (const language of ["en", "es"] as const) {
  test(`creates the administrator password from an activation link in ${language}`, async ({
    page,
    request,
  }) => {
    await request.post("/__test/reset");
    const { token } = await (await request.post("/__test/setup")).json();
    await page.addInitScript(
      (value) => localStorage.setItem("nimbot-panel-language", value),
      language,
    );
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`/setup#token=${token}`);
    await expect(page).toHaveURL(/\/setup$/);
    const password = "my administrator password";
    const label =
      language === "en"
        ? "Administrator password"
        : "Contraseña de administración";
    const confirmation =
      language === "en" ? "Confirm password" : "Confirmar contraseña";
    const submit =
      language === "en"
        ? "Save password and open panel"
        : "Guardar contraseña y abrir el panel";
    await page.getByLabel(label, { exact: true }).fill(password);
    await page
      .getByLabel(confirmation, { exact: true })
      .fill("different password");
    await page.getByRole("button", { name: submit }).click();
    await expect(page.getByRole("alert")).toContainText(
      language === "en"
        ? "Passwords must match"
        : "Las contraseñas deben coincidir",
    );
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(password);
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.getByLabel(confirmation, { exact: true }).fill(password);
    await page.getByRole("button", { name: submit }).click();
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", {
        name: language === "en" ? "Your agents." : "Tus agentes.",
      }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("button", {
        name: language === "en" ? "Sign out" : "Cerrar sesión",
      })
      .click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel(label, { exact: true }).fill(password);
    await page
      .getByRole("button", {
        name:
          language === "en"
            ? "Sign in to the panel"
            : "Iniciar sesión en el panel",
      })
      .click();
    await expect(page).toHaveURL("/");
    await page.goto(`/setup#token=${token}`);
    await expect(
      page.getByRole("link", {
        name:
          language === "en"
            ? "Sign in to the panel"
            : "Iniciar sesión en el panel",
      }),
    ).toBeVisible();
  });
}

test("requires an activation link when opening an unconfigured installation", async ({
  page,
  request,
}) => {
  await request.post("/__test/reset");
  await request.post("/__test/setup");
  await page.goto("/login");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(
    page.getByText("Open the activation link shown by the installer.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});
