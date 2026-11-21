import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { openAgentRegistry } from "../apps/server/src/agent-registry.js";
import { openAgentProcessStore } from "../apps/server/src/agent-process-store.js";
import { openProcessHostCredentials } from "../apps/server/src/process-host-credentials.js";
import { openBotSecrets } from "../apps/server/src/bot-secret.js";
import { createProcessAgents } from "../apps/server/src/process-agents.js";
import { agentProcessDirectories } from "../apps/server/src/agent-process-config.js";
import { createHostTasks } from "../apps/server/src/host-tasks.js";

/** Built Hosts + pinned OpenCode, with model traffic served by this local fixture. */
it.skipIf(process.env.NIMBOT_TEST_NATIVE_OPENCODE !== "1")(
  "runs concurrent native OpenCode sessions and restores each conversation after Host restart",
  async () => {
    const executablePath =
      process.env.NIMBOT_TEST_OPENCODE_PATH || process.env.PATH!;
    expect(
      execFileSync("opencode", ["--version"], {
        env: { PATH: executablePath },
        encoding: "utf8",
      })
        .trim()
        .replace(/^opencode v/, ""),
    ).toBe("2.2.7");
    const directory = await mkdtemp(join(tmpdir(), "nimbot-native-opencode-"));
    const pending = new Map<string, ServerResponse>();
    const histories: { agent: string; text: string; resumed: boolean }[] = [];
    const failures: string[] = [];
    function send(response: ServerResponse, text: string) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: text }, null],
        [{}, "stop"],
      ])
        response.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    }
    const server = createServer(async (request, response) => {
      try {
        const agent = request.url?.split("/")[1];
        if (!["first", "second"].includes(agent!)) {
          response.writeHead(404).end();
          return;
        }
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        if (!body.tools?.length) {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              id: "title",
              object: "chat.completion",
              model: "fixture",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Local fixture" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
          );
          return;
        }
        const text = JSON.stringify(body.messages);
        const resumed = text.includes("RESUME_AFTER_RESTART");
        histories.push({ agent: agent!, text, resumed });
        const foreign = agent === "first" ? "SECOND" : "FIRST";
        if (
          ["AGENT_SENTINEL", "REPLY_SENTINEL", "RESUMED"].some((marker) =>
            text.includes(`${foreign}_${marker}`),
          )
        )
          failures.push("Foreign agent history entered a model request");
        if (resumed) send(response, `${agent!.toUpperCase()}_RESUMED`);
        else {
          pending.set(agent!, response);
          // Both engines must reach the model before either receives a response.
          if (pending.size === 2) {
            for (const [id, response] of pending)
              send(response, `${id.toUpperCase()}_REPLY_SENTINEL`);
            pending.clear();
          }
        }
      } catch (error) {
        failures.push(String(error));
        response.writeHead(500).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test model port");
    const path = join(directory, "server.sqlite");
    const registry = openAgentRegistry(path);
    const store = openAgentProcessStore(path);
    const botSecrets = await openBotSecrets(join(directory, "bot-secrets"));
    const credentials = await openProcessHostCredentials(
      join(directory, "host-secrets"),
      store,
    );
    const runtime = createProcessAgents({
      registry,
      store,
      botSecrets,
      credentials,
      schedules: { removeByAgent: () => {} },
      dataDirectory: directory,
      hostEntrypoint: fileURLToPath(
        new URL("../apps/agent-host/dist/serve.js", import.meta.url),
      ),
      executablePath,
      taskTimeoutSeconds: 60,
      beforeStop: async () => {},
      afterStart: async () => {},
    });
    try {
      for (const [id, botId] of [
        ["first", 123],
        ["second", 456],
      ] as const) {
        registry.registerLinkedAgent(
          { id, name: id, ownerId: 42, instructions: "" },
          { id: botId, username: `${id}_bot` },
          await botSecrets.save(`${botId}:fixture-token`),
        );
        const directories = agentProcessDirectories(directory, id);
        await mkdir(directories.workspace, { recursive: true });
        await writeFile(
          join(directories.workspace, "opencode.json"),
          JSON.stringify({
            model: "fixture/fixture",
            small_model: "fixture/fixture",
            enabled_providers: ["fixture"],
            provider: {
              fixture: {
                npm: "@ai-sdk/openai-compatible",
                options: {
                  baseURL: `http://127.0.0.1:${address.port}/${id}/v1`,
                  apiKey: "fixture-only",
                },
                models: {
                  fixture: {
                    name: "fixture",
                    limit: { context: 16000, output: 1000 },
                  },
                },
              },
            },
          }),
        );
      }
      await Promise.all([runtime.start("first"), runtime.start("second")]);
      async function run(id: string, prompt: string) {
        return createHostTasks(
          await runtime.readHost(id),
          fetch,
          () => delay(25),
          65000,
        )(prompt);
      }
      const results = await Promise.all([
        run("first", "FIRST_AGENT_SENTINEL"),
        run("second", "SECOND_AGENT_SENTINEL"),
      ]);
      expect(results).toEqual([
        "FIRST_REPLY_SENTINEL",
        "SECOND_REPLY_SENTINEL",
      ]);
      const sessions = await Promise.all(
        ["first", "second"].map(
          async (id) =>
            JSON.parse(
              await readFile(
                join(
                  agentProcessDirectories(directory, id).tasks,
                  "engine-session.json",
                ),
                "utf8",
              ),
            ).sessionId,
        ),
      );
      expect(sessions[0]).not.toBe(sessions[1]);
      for (const id of ["first", "second"])
        expect(
          (await readdir(agentProcessDirectories(directory, id).data)).length,
        ).toBeGreaterThan(0);
      await Promise.all([runtime.restart("first"), runtime.restart("second")]);
      expect(
        await Promise.all([
          run("first", "RESUME_AFTER_RESTART"),
          run("second", "RESUME_AFTER_RESTART"),
        ]),
      ).toEqual(["FIRST_RESUMED", "SECOND_RESUMED"]);
      for (const [index, id] of ["first", "second"].entries()) {
        expect(
          histories.find((entry) => entry.agent === id && entry.resumed)?.text,
        ).toContain(`${id.toUpperCase()}_REPLY_SENTINEL`);
        expect(
          JSON.parse(
            await readFile(
              join(
                agentProcessDirectories(directory, id).tasks,
                "engine-session.json",
              ),
              "utf8",
            ),
          ).sessionId,
        ).toBe(sessions[index]);
      }
      expect(failures).toEqual([]);
    } catch (error) {
      throw new Error(
        `${String(error)}; model turns: ${JSON.stringify(histories.map(({ agent, resumed }) => ({ agent, resumed })))}; fixture failures: ${JSON.stringify(failures)}`,
        { cause: error },
      );
    } finally {
      await runtime.close();
      store.close();
      registry.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  150000,
);
