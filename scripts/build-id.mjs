import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Hash build inputs, including the pinned dependency graph, for portable restores.
const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "infrastructure/docker/nimbot.Dockerfile",
  "scripts/build-id.mjs",
  "scripts/state-schema.mjs",
  "scripts/state-schema.d.mts",
];
async function collect(directory) {
  for (const entry of await readdir(resolve(root, directory), {
    withFileTypes: true,
  })) {
    if (["node_modules", "dist", "build-id"].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) files.push(path);
  }
}
await collect("apps");
await collect("scripts/state-schema");
const hash = createHash("sha256");
for (const file of files.sort()) {
  hash.update(relative(root, resolve(root, file)));
  hash.update("\0");
  hash.update(await readFile(resolve(root, file)));
  hash.update("\0");
}
await writeFile(resolve(root, "apps/build-id"), hash.digest("hex") + "\n");
