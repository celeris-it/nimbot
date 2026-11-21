import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

it.skipIf(process.env.NIMBOT_TEST_DOCKER_IMAGES !== "1")(
  "builds the application image with readable runtime files from owner-only source",
  async () => {
    const context = await mkdtemp(join(tmpdir(), "nimbot-image-permissions-"));
    const application = `nimbot-image-permissions:${basename(context)}`;
    const docker = (...args: string[]) =>
      exec("docker", args, { maxBuffer: 8 * 1024 * 1024 });
    const applicationDockerfile = join(
      context,
      "infrastructure/docker/nimbot.Dockerfile",
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

      await docker(
        "build",
        "-f",
        applicationDockerfile,
        "-t",
        application,
        context,
      );

      for (const image of [application]) {
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
    } finally {
      await Promise.all([
        docker("image", "rm", application).catch(() => undefined),
        rm(context, { recursive: true, force: true }),
      ]);
    }
  },
  20 * 60 * 1000,
);
