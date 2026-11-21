/**
 * Browser probe. OpenCode runs this script through its Agent Host terminal.
 * Prints one JSON object with the final URL, title and visible text.
 */
import { chromium } from "playwright";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function browserProfileDirectory(env: NodeJS.ProcessEnv): string {
  return resolve(
    env.AGENT_BROWSER_PROFILE_DIR ||
      resolve(
        env.AGENT_STATE_DIR || "/home/node/.local/share/nimbot",
        "browser",
      ),
  );
}

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
  const profile = browserProfileDirectory(process.env);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const browser = await chromium.launchPersistentContext(profile, {
    headless: true,
  });
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

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => undefined)) ===
    fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    // One readable line for the agent; no stack traces or local paths.
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message.split("\n")[0] : "failed",
      }),
    );
    process.exitCode = 1;
  });
