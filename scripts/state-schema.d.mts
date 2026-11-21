import type { DatabaseSync } from "node:sqlite";

export function prepareStateSchema(
  path: string,
  kind: "server" | "server-process" | "tasks" | "memory",
  options?: {
    existing?: boolean;
    legacy?: boolean;
    definition?: {
      version: number;
      current?: string;
      migrations: Record<number, (database: DatabaseSync) => void>;
    };
  },
): void;
