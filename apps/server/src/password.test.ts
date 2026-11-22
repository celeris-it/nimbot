import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { verifyPassword } from "./panel/panel-auth.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function helper() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-password-"));
  dirs.push(dir);
  const sources = {
    password: "./password.ts",
    "panel-auth": "./panel/panel-auth.ts",
  };
  for (const [name, path] of Object.entries(sources)) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    await writeFile(
      join(dir, `${name}.mjs`),
      compiled.replace('"./panel/panel-auth.js"', '"./panel-auth.mjs"'),
    );
  }
  return join(dir, "password.mjs");
}
it.each(["eight!#?", "a private password with spaces and $characters"])(
  "hashes a valid password from stdin without echoing it",
  async (password) => {
    const result = spawnSync(process.execPath, [await helper(), "--stdin"], {
      input: password,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}\n$/);
    expect(result.stdout).not.toContain(password);
    expect(await verifyPassword(password, result.stdout.trim())).toBe(true);
  },
);
it.each(["", "a".repeat(7), "a".repeat(257)])(
  "rejects invalid password length without echoing input",
  async (password) => {
    const result = spawnSync(process.execPath, [await helper(), "--stdin"], {
      input: password,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("between 8 and 256");
  },
);
