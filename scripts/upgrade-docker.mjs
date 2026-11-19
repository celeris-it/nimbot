import process from "node:process";
import { spawnSync } from "node:child_process";

function invoke(args, options) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

export function docker(args, options = {}) {
  const result = invoke(args, options);
  if (result.error || result.status !== 0) {
    const action = args.slice(0, 2).join(" ");
    // Only controlled state helper diagnostics are forwarded. Docker inspect and
    // Compose config can include credentials in their output.
    const detail = options.state && result.stderr?.trim().split("\n").at(-1);
    throw new Error(`Docker ${action} failed.${detail ? ` ${detail}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
}

export function inspect(kind, ref, optional = false) {
  const result = invoke([kind, "inspect", ref]);
  if (result.status === 0) return JSON.parse(result.stdout)[0];
  if (
    optional &&
    /No such (container|object|volume|network)/i.test(result.stderr)
  )
    return undefined;
  throw new Error(`Could not inspect ${kind} ${ref}.`);
}

export function listing(kind, label) {
  const flags = kind === "container" ? "-aq" : "-q";
  return docker([kind, "ls", flags, "--filter", `label=${label}`])
    .split("\n")
    .filter(Boolean);
}

export function compose(project, source, env, args, override) {
  return docker(
    [
      "compose",
      "--project-name",
      project,
      "--env-file",
      "/installation/.env",
      "-f",
      `${source}/compose.yaml`,
      ...(override ? ["-f", override] : []),
      ...args,
    ],
    { env: { ...process.env, ...env } },
  );
}
