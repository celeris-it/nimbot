import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const image = process.env.NIMBOT_TEST_DOCKER_IMAGE;
it.skipIf(!image)(
  "verifies pinned OpenCode MCP over ACP inside the non-root Agent Host image",
  () => {
    const dockerfile = readFileSync(
      new URL(
        "../infrastructure/docker/agent-host.Dockerfile",
        import.meta.url,
      ),
      "utf8",
    );
    const version = /opencode-ai@([\d.]+)/.exec(dockerfile)?.[1];
    expect(version).toBeTruthy();
    const output = execFileSync(
      "docker",
      [
        "--host",
        `unix://${process.env.NIMBOT_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock"}`,
        "run",
        "--rm",
        "--init",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        "1g",
        "--pids-limit",
        "256",
        "--mount",
        `type=bind,src=${fileURLToPath(new URL("fixtures/opencode-mcp.mjs", import.meta.url))},dst=/tmp/opencode-mcp.mjs,readonly`,
        "--entrypoint",
        "node",
        image!,
        "/tmp/opencode-mcp.mjs",
        version!,
      ],
      { encoding: "utf8", timeout: 180000 },
    );
    expect(output).toContain("Verified pinned OpenCode MCP");
    expect(output).toContain(
      "Verified private memory retrieval in a fresh OpenCode session.",
    );
    expect(output).toContain(
      "Verified fresh delegated sessions preserve the owner conversation.",
    );
  },
  190000,
);
