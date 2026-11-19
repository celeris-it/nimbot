import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreAgentVolumes } from "../scripts/restore-agent-volumes.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-restore-"));
  directories.push(dir);
  const names = ["workspace", "engine", "tasks"].map(
    (kind) => `nimbot-agent-1-${kind}`,
  );
  for (const name of names)
    await writeFile(join(dir, `${name}.tar.gz`), "archive");
  const volumes = new Map<
    string,
    { Name: string; Driver: string; Labels: Record<string, string> }
  >();
  const run = vi.fn((command: string, args: string[]) => {
    if (command === "tar") return "./\n";
    if (args[0] === "volume" && args[1] === "ls")
      return [...volumes.keys()].join("\n");
    const name = args.at(-1)!;
    if (args[0] === "volume" && args[1] === "create") {
      const labels: Record<string, string> = {};
      args.forEach((arg, index) => {
        if (arg === "--label") {
          const [key, value] = args[index + 1]!.split("=");
          labels[key!] = value!;
        }
      });
      volumes.set(name, { Name: name, Driver: "local", Labels: labels });
      return name;
    }
    if (args[0] === "volume" && args[1] === "inspect")
      return JSON.stringify([volumes.get(name)]);
    if (args[0] === "run") return "";
    throw new Error("Unexpected command");
  });
  return {
    dir,
    names,
    volumes,
    run,
    restore: () => restoreAgentVolumes(dir, "agent-1", "a".repeat(32), run),
  };
}

it("creates and labels all canonical volumes before extraction with numeric ownership", async () => {
  const f = await fixture();
  f.restore();
  expect([...f.volumes.keys()]).toEqual(f.names);
  for (const volume of f.volumes.values()) {
    expect(volume.Labels).toMatchObject({
      "io.nimbot.agent-id": "agent-1",
      "io.nimbot.installation": "a".repeat(32),
    });
  }
  const commands = f.run.mock.calls.map(([, args]) => args);
  const firstExtract = commands.findIndex((args) => args[0] === "run");
  expect(
    commands.slice(0, firstExtract).filter((args) => args[1] === "create"),
  ).toHaveLength(3);
  const extracts = commands.filter((args) => args[0] === "run");
  expect(extracts).toHaveLength(3);
  extracts.forEach((args, index) => {
    expect(args).toEqual(
      expect.arrayContaining([
        "--numeric-owner",
        "--same-owner",
        "-xzpf",
        `/backup/${f.names[index]}.tar.gz`,
        `type=volume,src=${f.names[index]},dst=/data,volume-nocopy`,
      ]),
    );
  });
});

it("rejects an incomplete backup before contacting Docker", async () => {
  const f = await fixture();
  await rm(join(f.dir, `${f.names[2]}.tar.gz`));
  expect(f.restore).toThrow();
  expect(f.run.mock.calls.every(([command]) => command === "tar")).toBe(true);
});

it("inspects and preserves an existing volume without creating or extracting anything", async () => {
  const f = await fixture();
  f.volumes.set(f.names[2]!, {
    Name: f.names[2]!,
    Driver: "local",
    Labels: {},
  });
  expect(f.restore).toThrow("already exists");
  expect(f.run).toHaveBeenCalledWith("docker", [
    "volume",
    "inspect",
    f.names[2],
  ]);
  expect(
    f.run.mock.calls.some(
      ([, args]) => args[0] === "run" || args[1] === "create",
    ),
  ).toBe(false);
});

it("does not treat a Docker inspection failure as an absent volume", async () => {
  const f = await fixture();
  f.run.mockImplementation((command) => {
    if (command === "docker") throw new Error("Docker unavailable");
    return "";
  });
  expect(f.restore).toThrow("Docker unavailable");
  expect(f.run.mock.calls.some(([, args]) => args[1] === "create")).toBe(false);
});

it("refuses a raced volume and leaves all created resources intact", async () => {
  const f = await fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation((command, args) => {
    const result = original(command, args);
    if (args[1] === "create")
      f.volumes.get(args.at(-1)!)!.Labels["io.nimbot.restore-operation"] =
        "another-attempt";
    return result;
  });
  expect(f.restore).toThrow("Conflicting volume");
  expect(f.volumes.size).toBe(1);
  expect(
    f.run.mock.calls.some(([, args]) => args[0] === "run" || args[1] === "rm"),
  ).toBe(false);
});

it("keeps partially extracted volumes after failure and rejects a blind retry", async () => {
  const f = await fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation((command, args) => {
    if (args[0] === "run") throw new Error("Extraction failed");
    return original(command, args);
  });
  expect(f.restore).toThrow("Extraction failed");
  expect(f.volumes.size).toBe(3);
  expect(f.restore).toThrow("already exists");
  expect(f.run.mock.calls.some(([, args]) => args[1] === "rm")).toBe(false);
});
