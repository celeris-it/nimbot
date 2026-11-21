import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

const image = process.env.NIMBOT_TEST_APPLICATION_IMAGE;
const dockerTimeoutMs = 60_000;
it.skipIf(!image)(
  "keeps SQLite FTS5 available in the application image so memory search cannot disappear unnoticed",
  () => {
    const output = execFileSync(
      "docker",
      [
        "--host",
        `unix://${process.env.NIMBOT_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock"}`,
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        "node",
        image!,
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(":memory:");
        db.exec("CREATE VIRTUAL TABLE t USING fts5(title, body)");
        db.exec("INSERT INTO t VALUES ('alpha', 'beta gamma')");
        console.log(JSON.stringify(db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'gam*'").get()));`,
      ],
      { encoding: "utf8", timeout: dockerTimeoutMs },
    );
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ n: 1 });
  },
  dockerTimeoutMs + 5_000,
);
