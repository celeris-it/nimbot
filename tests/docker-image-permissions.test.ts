import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

it.skipIf(process.env.NIMBOT_TEST_DOCKER_IMAGES !== "1")(
  "builds images with readable runtime files from owner-only source",
  async () => {
    const context = await mkdtemp(join(tmpdir(), "nimbot-image-permissions-"));
    const server = `nimbot-image-permissions-server:${basename(context)}`;
    const host = `nimbot-image-permissions-host:${basename(context)}`;
    const upgrade = `nimbot-image-permissions-upgrade:${basename(context)}`;
    const docker = (...args: string[]) =>
      exec("docker", args, { maxBuffer: 8 * 1024 * 1024 });
    const serverDockerfile = join(
      context,
      "infrastructure/docker/server.Dockerfile",
    );
    const schemaCheck = `
      import { readFileSync, readdirSync } from 'node:fs';

      if (process.getuid() === 0) throw new Error('Expected a non-root user');
      await import('/app/scripts/state-schema.mjs');
      const schema = '/app/scripts/state-schema';
      for (const file of readdirSync(schema)) readFileSync(schema + '/' + file);
    `;
    try {
      for (const entry of [
        ".dockerignore",
        "apps",
        "infrastructure",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "scripts",
        "tsconfig.base.json",
      ]) {
        await cp(join(root, entry), join(context, entry), {
          recursive: true,
          filter: (source) =>
            !["node_modules", "dist", ".svelte-kit"].includes(basename(source)),
        });
      }
      await exec("chmod", ["-R", "u=rwX,go=", context]);

      await docker("build", "-f", serverDockerfile, "-t", server, context);
      await docker(
        "build",
        "-f",
        join(context, "infrastructure/docker/agent-host.Dockerfile"),
        "-t",
        host,
        context,
      );
      await docker(
        "build",
        "--target",
        "upgrade",
        "-f",
        serverDockerfile,
        "-t",
        upgrade,
        context,
      );

      for (const image of [server, host]) {
        await docker(
          "run",
          "--rm",
          "--network",
          "none",
          "--entrypoint",
          "node",
          image,
          "--input-type=module",
          "-e",
          schemaCheck,
        );
      }
      await docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "12345:12345",
        "--entrypoint",
        "node",
        upgrade,
        "--input-type=module",
        "-e",
        `${schemaCheck}
        for (const file of readdirSync('/app/scripts')) {
          if (file.startsWith('upgrade') && file.endsWith('.mjs')) {
            readFileSync('/app/scripts/' + file);
          }
        }
        readFileSync('/app/scripts/upgrade.mjs');
      `,
      );
    } finally {
      await Promise.all([
        docker("image", "rm", server, host, upgrade).catch(() => undefined),
        rm(context, { recursive: true, force: true }),
      ]);
    }
  },
  20 * 60 * 1000,
);
