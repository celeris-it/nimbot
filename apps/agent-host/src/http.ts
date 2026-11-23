import {
  ATTACHMENT_LIMIT,
  attachmentTaskId,
  type createAttachments,
} from "./attachments.js";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { parseJson, validated } from "./validate.js";
import type { TaskRunner } from "./tasks.js";
import {
  modelAdmission,
  modelSelection,
  type EngineModels,
} from "./engine-usage.js";
import type { MemoryStore } from "./memory-store.js";
import {
  isTaskIdentity,
  isTaskToolAccess,
  type TaskIdentity,
  type TaskToolAccess,
} from "./task-identity.js";
import {
  isInvocationId,
  isToolOutcome,
  toolJson,
  TOOL_RESULT_BYTES,
} from "./tool-requests.js";
import {
  EngineAuthError,
  isProviderId,
  isApiKey,
  type EngineAuth,
} from "./engine-auth.js";

const PROMPT_ERROR = "prompt must contain 1–16000 characters";
/** Fields are listed in check order: the first failure is the one reported. */
const taskRequest = z
  .object(
    {
      prompt: z
        .string({ error: PROMPT_ERROR })
        .refine((prompt) => prompt.trim() && prompt.length <= 16_000, {
          error: PROMPT_ERROR,
        }),
      credentials: z
        .never({
          error: "Configure providers from AI providers in the Nimbot panel",
        })
        .optional(),
      execution: z
        .custom<TaskIdentity>(isTaskIdentity, {
          error: "Invalid execution identity",
        })
        .optional(),
      tools: z.unknown().optional(),
      sessionMode: z.unknown().optional(),
      admission: modelAdmission.optional(),
    },
    { error: PROMPT_ERROR },
  )
  .superRefine((request, ctx) => {
    if (
      request.tools !== undefined &&
      (!request.execution || !isTaskToolAccess(request.tools))
    )
      ctx.addIssue({ code: "custom", message: "Invalid task tool access" });
    if (
      request.sessionMode !== undefined &&
      (request.sessionMode !== "fresh" || !request.execution)
    )
      ctx.addIssue({ code: "custom", message: "Invalid session mode" });
    if (request.admission && !request.execution)
      ctx.addIssue({ code: "custom", message: "Invalid model admission" });
  });
const approvalRequest = z.object(
  { decision: z.enum(["allow", "deny"]) },
  { error: "decision must be allow or deny" },
);
const invocationParams = z.object(
  { invocationId: z.string().refine(isInvocationId) },
  { error: "Invalid invocation ID" },
);
const eventsQuery = z.object({
  after: z
    .string()
    .regex(/^\d+$/)
    .refine((after) => Number.isSafeInteger(Number(after)))
    .default("0"),
});
const pageQuery = z.object({
  page: z
    .string()
    .default("1")
    .transform(Number)
    .pipe(z.number().int().min(1).max(1000)),
});

/** Answers 503 before any validation when an optional service is not wired. */
const available = (present: () => unknown, message: string) =>
  createMiddleware(async (c, next) =>
    present() ? next() : c.json({ error: message }, 503),
  );

export interface HostConfig {
  token: string;
  workspace: string;
}

export function readHostConfig(env: NodeJS.ProcessEnv): HostConfig {
  const token = env.AGENT_HOST_TOKEN ?? "";
  if (token.length < 32 || /\s/.test(token)) {
    throw new Error(
      "AGENT_HOST_TOKEN must contain at least 32 characters without whitespace.",
    );
  }
  return { token, workspace: env.WORKSPACE || "/workspace" };
}

/** Container readiness only: does not start or validate the AI engine. */
export function createHostApi(
  config: HostConfig,
  runner?: TaskRunner,
  auth?: EngineAuth,
  memory?: Pick<MemoryStore, "list" | "delete">,
  attachments?: ReturnType<typeof createAttachments>,
  models?: EngineModels,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("*", bearerAuth({ token: config.token }));
  app.use(
    "/tasks",
    bodyLimit({
      maxSize: 49_152,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  app.use(
    "/tasks/:id/approvals/:approvalId",
    bodyLimit({
      maxSize: 1024,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  app.use(
    "/tasks/:id/tool-requests/:invocationId/result",
    bodyLimit({
      maxSize: TOOL_RESULT_BYTES,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  app.put("/attachments/:id/:name", async (c) => {
    if (!attachments) return c.notFound();
    const { id, name } = c.req.param();
    const size = c.req.header("X-Attachment-Size");
    if (
      !attachmentTaskId.test(id) ||
      !size ||
      !/^\d{1,8}$/.test(size) ||
      Number(size) > ATTACHMENT_LIMIT
    )
      return c.json({ error: "Invalid attachment metadata" }, 400);
    try {
      await attachments.importFile(
        id,
        name,
        c.req.raw.body ??
          new ReadableStream({ start: (controller) => controller.close() }),
        Number(size),
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]),
      );
      return c.body(null, 204);
    } catch {
      return c.json({ error: "Attachment could not be saved" }, 400);
    }
  });
  app.post("/tasks/:id/attachment", async (c) => {
    const id = c.req.param("id");
    if (
      !attachments ||
      !attachmentTaskId.test(id) ||
      (await runner?.get(id))?.status !== "completed"
    )
      return c.notFound();
    const file = attachments.consume(id);
    return file
      ? c.body(new Uint8Array(file.bytes), 200, {
          "Content-Type": "application/octet-stream",
          "X-Attachment-Name": file.name,
          "Content-Length": String(file.bytes.length),
        })
      : c.notFound();
  });
  const needsRunner = available(() => runner, "Task execution unavailable");
  app.get(
    "/tasks/:id/tool-requests/:invocationId",
    needsRunner,
    validated("param", invocationParams),
    async (c) =>
      c.json({
        pending: await runner!.isToolPending(
          c.req.param("id"),
          c.req.param("invocationId"),
        ),
      }),
  );
  app.post(
    "/tasks/:id/tool-requests/:invocationId/result",
    needsRunner,
    validated("param", invocationParams),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => null);
      if (!isToolOutcome(body))
        return c.json({ error: "Invalid tool outcome" }, 400);
      try {
        toolJson(body, TOOL_RESULT_BYTES);
      } catch {
        return c.json({ error: "Invalid or oversized tool outcome" }, 400);
      }
      return (await runner!.replyTool(
        c.req.param("id"),
        c.req.param("invocationId"),
        body,
      ))
        ? c.json({ status: "recorded" })
        : c.json({ error: "Tool request is not awaiting this outcome" }, 409);
    },
  );
  app.post("/tasks", needsRunner, async (c) => {
    const parsed = await parseJson(c, taskRequest, {
      malformed: "Invalid JSON",
    });
    if (parsed.response) return parsed.response;
    const { prompt, execution, tools, sessionMode, admission } = parsed.data;
    if (admission && (runner!.isBusy() || !models?.accept(admission)))
      return c.json({ error: "Model admission expired" }, 412);
    const id = await runner!.submit(
      prompt,
      execution,
      tools as TaskToolAccess | undefined,
      sessionMode as "fresh" | undefined,
      admission?.model,
    );
    return id
      ? c.json({ id, status: "accepted" }, 202)
      : c.json({ error: "Agent is busy" }, 409);
  });
  app.post("/tasks/:id/cancel", async (c) => {
    if (!runner) return c.json({ error: "Task execution unavailable" }, 503);
    const id = c.req.param("id");
    try {
      const task = await runner.get(id);
      if (!task) return c.json({ error: "Task not found" }, 404);
      return runner.cancel(id)
        ? c.json({ id, status: "cancelling" }, 202)
        : c.json({ error: "Task is not running" }, 409);
    } catch {
      return c.json({ error: "Task state unavailable" }, 503);
    }
  });
  app.post("/tasks/:id/approvals/:approvalId", needsRunner, async (c) => {
    const parsed = await parseJson(c, approvalRequest, {
      malformed: "Invalid JSON",
    });
    if (parsed.response) return parsed.response;
    return runner!.decide(
      c.req.param("id"),
      c.req.param("approvalId"),
      parsed.data.decision === "allow",
    )
      ? c.json({ status: "recorded" })
      : c.json({ error: "No such pending approval" }, 404);
  });
  app.get("/tasks/current", async (c) => {
    if (!runner) return c.json({ error: "Task execution unavailable" }, 503);
    try {
      return c.json({ task: await runner.getCurrent() });
    } catch {
      return c.json({ error: "Task state unavailable" }, 503);
    }
  });
  app.get("/tasks/:id/status", async (c) => {
    if (!runner) return c.json({ error: "Task execution unavailable" }, 503);
    try {
      const task = await runner.get(c.req.param("id"));
      return task
        ? c.json({ id: task.id, status: task.status })
        : c.json({ error: "Task not found" }, 404);
    } catch {
      return c.json({ error: "Task state unavailable" }, 503);
    }
  });
  app.get(
    "/tasks/:id/events",
    validated(
      "query",
      eventsQuery,
      "after must be a non-negative safe integer",
    ),
    async (c) => {
      const { after } = c.req.valid("query");
      const id = c.req.param("id");
      if (!runner || !(await runner.get(id)))
        return c.json({ error: "Task not found" }, 404);
      const events = await runner.getEvents(id, Number(after));
      return c.json({
        id,
        events,
        ...(events.some((event) => event.status === "completed") &&
        attachments?.has(id)
          ? { attachment: true }
          : {}),
      });
    },
  );
  app.get("/tasks/:id/usage", needsRunner, async (c) => {
    const id = c.req.param("id");
    if (!(await runner!.get(id))) return c.notFound();
    return c.json({ usage: await runner!.getUsage(id) });
  });
  app.get("/tasks/:id", async (c) => {
    const task = await runner?.get(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "Task not found" }, 404);
  });
  app.get("/health", async (c) => {
    try {
      await access(
        config.workspace,
        constants.R_OK | constants.W_OK | constants.X_OK,
      );
      return c.json({
        status: "ok",
        workspace: "writable",
        engine: runner?.isBusy() ? "busy" : "not_started",
      });
    } catch {
      return c.json(
        {
          status: "unavailable",
          workspace: "unavailable",
          engine: runner?.isBusy() ? "busy" : "not_started",
        },
        503,
      );
    }
  });
  app.get(
    "/memories",
    available(() => memory, "Memory unavailable"),
    validated("query", pageQuery, "Invalid page"),
    (c) => c.json(memory!.list(c.req.valid("query").page)),
  );
  app.post("/memories/:id/delete", (c) => {
    if (!memory) return c.json({ error: "Memory unavailable" }, 503);
    return memory.delete(c.req.param("id"))
      ? c.json({ deleted: true })
      : c.json({ error: "Memory not found" }, 404);
  });
  app.use(
    "/providers/*",
    bodyLimit({
      maxSize: 16_384,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  app.get("/models", async (c) => {
    if (!models) return c.json({ error: "Model catalog unavailable" }, 503);
    try {
      return c.json({ models: await models.list() });
    } catch {
      return c.json({ error: "Model catalog unavailable" }, 503);
    }
  });
  app.post(
    "/models/check",
    bodyLimit({
      maxSize: 2048,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
    async (c) => {
      if (!models) return c.json({ error: "Model catalog unavailable" }, 503);
      const parsed = await parseJson(
        c,
        z.strictObject({
          model: modelSelection.nullable(),
          issue: z.boolean(),
        }),
        { malformed: "Invalid JSON" },
      );
      if (parsed.response) return parsed.response;
      return c.json(await models.check(parsed.data.model, parsed.data.issue));
    },
  );
  if (auth) {
    app.get("/providers/checks", async (c) => {
      return c.json(await auth.checkProviders());
    });
    app.get("/providers", async (c) => {
      return c.json(await auth.status());
    });
    app.post("/providers/:provider/device-login", (c) => {
      const provider = c.req.param("provider");
      if (provider !== "openai" && provider !== "opencode") return c.notFound();
      return c.json(
        provider === "openai" ? auth.startLogin() : auth.startLogin(provider),
        202,
      );
    });
    app.post("/providers/:provider/device-login/:attempt/cancel", async (c) => {
      const { provider, attempt } = c.req.param();
      if (provider !== "openai" && provider !== "opencode") return c.notFound();
      return c.json(
        await (provider === "openai"
          ? auth.cancelLogin(attempt)
          : auth.cancelLogin(attempt, provider)),
      );
    });
    app.post("/providers/:provider", async (c) => {
      const id = c.req.param("provider");
      if (!isProviderId(id)) throw new EngineAuthError("invalid");
      const body: unknown = await c.req.json().catch(() => null);
      const key =
        body && typeof body === "object" && "key" in body
          ? body.key
          : undefined;
      if (!isApiKey(key)) throw new EngineAuthError("invalid");
      await auth.save(id, key);
      return c.json({ saved: true });
    });
    app.post("/providers/:provider/remove", async (c) => {
      const id = c.req.param("provider");
      if (!isProviderId(id)) throw new EngineAuthError("invalid");
      await auth.remove(id);
      return c.json({ removed: true });
    });
  }
  app.onError((error, c) =>
    error instanceof EngineAuthError
      ? c.json(
          {
            ...(error.reason ? { reason: error.reason } : {}),
            error: {
              busy: "Agent is busy. Try again after the task or login finishes.",
              invalid: "Invalid provider or API key.",
              not_found: "Login attempt not found. Start a new login.",
              unavailable: "Provider settings unavailable.",
              rejected: "The provider rejected the API key.",
              restricted: "The provider denied access with this API key.",
              rate_limited:
                "The provider rate limited the API key check. Try again shortly.",
              check_unavailable:
                "Could not validate the API key. Try again when the provider is available.",
            }[error.kind],
          },
          {
            busy: 409,
            invalid: 400,
            not_found: 404,
            unavailable: 503,
            rejected: 422,
            restricted: 403,
            rate_limited: 429,
            check_unavailable: 502,
          }[error.kind] as 409 | 400 | 404 | 503 | 422 | 403 | 429 | 502,
        )
      : error instanceof HTTPException
        ? error.getResponse()
        : c.json({ error: "Agent Host request failed" }, 500),
  );
  return app;
}
