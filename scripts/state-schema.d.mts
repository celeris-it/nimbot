import type { DatabaseSync } from "node:sqlite";

export const taskExecutionSchema: string;

export function prepareStateSchema(
  path: string | DatabaseSync,
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
