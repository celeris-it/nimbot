import { createDockerApi, type DockerApi } from "./docker-api.js";

/** Explains why Docker is unreachable, or returns undefined when it answers. */
export async function checkDockerAccess(
  socketPath: string,
  call: DockerApi = createDockerApi(socketPath, []),
): Promise<string | undefined> {
  try {
    const result = await call("/_ping");
    if (result.code === 200) return undefined;
    return `Docker answered ${result.code} on ${socketPath}; check that it is the Docker Engine socket`;
  } catch (error) {
    switch ((error as NodeJS.ErrnoException | undefined)?.code) {
      case "EACCES":
      case "EPERM":
        return "cannot access Docker socket: permission denied; check DOCKER_SOCKET_GID";
      case "ENOENT":
        return `Docker socket not found at ${socketPath}; check DOCKER_SOCKET_PATH and the socket mount`;
      default:
        return `Docker is not responding on ${socketPath}`;
    }
  }
}
