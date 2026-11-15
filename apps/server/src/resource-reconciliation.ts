import { agentResourceNames } from "./container-resources.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";
import type { openAgentRegistry } from "./agent-registry.js";

type Resource = {
  agentId: string;
  kind: "container" | "volume" | "network";
  ref: string;
};
export type ResourceInventory =
  | { status: "ok"; missing: Resource[]; untracked: Resource[] }
  | { status: "unavailable" };
const label = "io.nimbot.agent-id";

/** Observations only: never adopt, recreate, or delete resources based on an inventory. */
export function createResourceReconciliation(
  registry: Pick<
    ReturnType<typeof openAgentRegistry>,
    "listResourceReferences"
  >,
  socketPath: string,
  call: DockerApi = createDockerApi(socketPath),
) {
  return async (): Promise<ResourceInventory> => {
    try {
      const expected: Resource[] = [];
      for (const agent of registry.listResourceReferences()) {
        if (agent.containerRef)
          expected.push({
            agentId: agent.id,
            kind: "container",
            ref: agent.containerRef,
          });
        if (agent.networkRef)
          expected.push({
            agentId: agent.id,
            kind: "network",
            ref: agent.networkRef,
          });
        if (agent.volumeRef) {
          // The registry stores the workspace volume; the fixed template determines the others.
          const volumes = agentResourceNames(agent.id).volumes;
          for (const ref of new Set([agent.volumeRef, ...volumes]))
            expected.push({ agentId: agent.id, kind: "volume", ref });
        }
      }
      const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
      const queries = [
        {
          kind: "container" as const,
          path: `/containers/json?all=true&filters=${filters}`,
        },
        { kind: "volume" as const, path: `/volumes?filters=${filters}` },
        { kind: "network" as const, path: `/networks?filters=${filters}` },
      ];
      const actual: Resource[] = [];
      await Promise.all(
        queries.map(async ({ kind, path }) => {
          const response = await call(path);
          if (response.code !== 200) throw new Error("Inventory unavailable");
          const parsed = JSON.parse(response.body);
          if (
            kind === "volume" &&
            parsed?.Warnings != null &&
            (!Array.isArray(parsed.Warnings) || parsed.Warnings.length > 0)
          )
            throw new Error("Incomplete Docker volume inventory");
          const items: unknown = kind === "volume" ? parsed?.Volumes : parsed;
          if (kind === "volume" && items === null) return;
          if (!Array.isArray(items))
            throw new Error("Invalid Docker inventory");
          for (const item of items) {
            const agentId: unknown = item?.Labels?.[label];
            const ref: unknown = kind === "volume" ? item?.Name : item?.Id;
            if (
              typeof agentId !== "string" ||
              !agentId ||
              agentId.length > 64 ||
              typeof ref !== "string" ||
              !(
                kind === "volume"
                  ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/
                  : /^[a-f0-9]{64}$/
              ).test(ref)
            )
              throw new Error("Invalid Docker inventory");
            actual.push({ agentId, kind, ref });
          }
        }),
      );
      const key = (r: Resource) => JSON.stringify([r.agentId, r.kind, r.ref]);
      const wanted = new Set(expected.map(key));
      const observed = new Set(actual.map(key));
      const sort = (a: Resource, b: Resource) => key(a).localeCompare(key(b));
      return {
        status: "ok",
        missing: expected.filter((r) => !observed.has(key(r))).sort(sort),
        untracked: actual.filter((r) => !wanted.has(key(r))).sort(sort),
      };
    } catch {
      // A failed or malformed listing cannot establish that a resource is missing.
      return { status: "unavailable" };
    }
  };
}
