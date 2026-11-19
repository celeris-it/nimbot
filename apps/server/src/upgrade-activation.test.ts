import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { waitForUpgradeActivation } from "./upgrade-activation.js";

it("keeps panel traffic blocked until the matching activation record is written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-activation-"));
  const gate = waitForUpgradeActivation(directory, "new-upgrade");
  const panel = vi.fn(() => new Response("panel"));
  const login = new Request("http://localhost/login");
  const readiness = new Request("http://localhost/_nimbot/upgrade-ready", {
    headers: { Authorization: "Bearer new-upgrade" },
  });
  try {
    await writeFile(join(directory, ".upgrade-activation"), "previous-upgrade");
    const waiting = gate.wait();
    expect(gate.isActive()).toBe(false);
    expect((await gate.fetch(login, panel)).status).toBe(503);
    expect((await gate.fetch(new Request(readiness.url), panel)).status).toBe(
      503,
    );
    expect((await gate.fetch(readiness, panel)).status).toBe(204);
    expect(panel).not.toHaveBeenCalled();
    await writeFile(join(directory, ".upgrade-activation"), "new-upgrade");
    expect(await waiting).toBe(true);
    expect(await (await gate.fetch(login, panel)).text()).toBe("panel");
  } finally {
    gate.close();
    await rm(directory, { recursive: true });
  }
});
