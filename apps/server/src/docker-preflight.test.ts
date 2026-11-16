import { expect, it, vi } from "vitest";
import type { DockerApi } from "./docker-api.js";
import { checkDockerAccess } from "./docker-preflight.js";

const failing = (code: string) =>
  vi.fn<DockerApi>().mockRejectedValue(Object.assign(new Error("x"), { code }));

it("returns nothing when Docker answers the ping", async () => {
  const call = vi.fn<DockerApi>().mockResolvedValue({ code: 200, body: "OK" });
  expect(await checkDockerAccess("/run/docker.sock", call)).toBeUndefined();
  expect(call).toHaveBeenCalledWith("/_ping");
});

it("explains a permission problem with the socket group", async () => {
  for (const code of ["EACCES", "EPERM"])
    expect(await checkDockerAccess("/run/docker.sock", failing(code))).toBe(
      "cannot access Docker socket: permission denied; check DOCKER_SOCKET_GID",
    );
});

it("explains a missing socket and an unresponsive daemon", async () => {
  expect(await checkDockerAccess("/run/docker.sock", failing("ENOENT"))).toBe(
    "Docker socket not found at /run/docker.sock; check DOCKER_SOCKET_PATH and the socket mount",
  );
  expect(
    await checkDockerAccess("/run/docker.sock", failing("ECONNREFUSED")),
  ).toBe("Docker is not responding on /run/docker.sock");
});

it("rejects an unexpected status from the socket", async () => {
  const call = vi.fn<DockerApi>().mockResolvedValue({ code: 404, body: "" });
  expect(await checkDockerAccess("/run/docker.sock", call)).toContain(
    "Docker answered 404",
  );
});
