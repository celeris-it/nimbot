/**
 * Browser probe. OpenCode runs it through its container terminal to read a
 * public web page: `node /app/apps/agent-host/dist/browser-demo.js <url>`.
 * Prints one JSON object with the final URL, title and visible text.
 */
import { chromium } from "playwright";

/** Only plain web pages: no file:, chrome:, data: or other schemes. */
export function parseBrowseUrl(input: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(input ?? "");
  } catch {
    throw new Error("Provide an http or https URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Provide an http or https URL without credentials.");
  return url;
}

async function main() {
  const url = parseBrowseUrl(process.argv[2]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url.href, {
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
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error: unknown) => {
    // One readable line for the agent; no stack traces or local paths.
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message.split("\n")[0] : "failed",
      }),
    );
    process.exitCode = 1;
  });
