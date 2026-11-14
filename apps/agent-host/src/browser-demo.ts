/** Phase 0 browser probe, invoked by OpenCode through its container terminal. */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.argv[2] ?? "https://example.com", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  console.log(
    JSON.stringify({
      url: page.url(),
      title: await page.title(),
      text: (await page.locator("body").innerText()).slice(0, 10_000),
    }),
  );
} finally {
  await browser.close();
}
