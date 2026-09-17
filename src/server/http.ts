import Fastify, { type FastifyInstance, type FastifyReply } from "fastify"
import { z } from "zod"
import { MODEL_ID } from "../openai/schemas.js"
import { ChatCompletionRequestSchema, type ChatMessage } from "../openai/schemas.js"
import { buildSseChunks } from "../openai/chat-completions.js"
import type { ValidatedToolCall } from "../chatgpt/protocol.js"
import { checkBearer, loadToken } from "../security/auth.js"
import { CgptError, Codes } from "../util/errors.js"
import { log } from "../util/log.js"
import type { TurnService } from "./turn-service.js"
import { randomId } from "../util/crypto.js"

const HeaderSchema = z.object({
  "x-cgpt-directory": z.string().optional(),
  "x-cgpt-worktree": z.string().optional(),
  "x-cgpt-session-id": z.string().optional(),
  authorization: z.string().optional(),
})

export interface ServerOptions {
  host: string
  port: number
  /** Overrides the token file (used by tests). */
  token?: string
}

export async function buildServer(turns: TurnService, opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    requestTimeout: 600_000,
    keepAliveTimeout: 65_000,
  })

  const token = opts.token ?? (await loadToken())

  const requireAuth = async (request: any, reply: FastifyReply): Promise<boolean> => {
    if (!token) {
      await reply.code(503).send({
        error: {
          message: "Bridge has no local auth token. Run: cgpt opencode install (or cgpt serve, which generates one).",
          type: "bridge_unconfigured",
          code: Codes.Unauthorized,
        },
      })
      return false
    }
    const ok = checkBearer(request.headers.authorization, token)
    if (!ok) {
      log.warn("rejected unauthenticated request", { ip: request.ip })
      await reply.code(401).send({
        error: {
          message: "Invalid or missing bearer token for the local bridge.",
          type: "invalid_request_error",
          code: Codes.Unauthorized,
        },
      })
      return false
    }
    return true
  }

  app.get("/health", async () => {
    // Intentionally reveals nothing about auth, bindings, or browser state.
    return { ok: true }
  })

  app.get("/v1/models", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return
    return {
      object: "list",
      data: [
        {
          id: MODEL_ID,
          object: "model",
          created: 0,
          owned_by: "cgpt-project-bridge",
        },
      ],
    }
  })

  app.post("/v1/chat/completions", async (request, reply) => {
    if (!(await requireAuth(request, reply))) return

    const headers = HeaderSchema.safeParse(request.headers)
    const reqMeta = headers.success ? headers.data : {}

    const body = ChatCompletionRequestSchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({
        error: {
          message: `Malformed request: ${body.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
          type: "invalid_request_error",
          code: Codes.BadRequest,
        },
      })
    }

    const req = body.data
    if (req.model !== MODEL_ID) {
      return reply.code(404).send({
        error: {
          message: `Unknown model "${req.model}". This bridge exposes only "${MODEL_ID}".`,
          type: "invalid_request_error",
          code: Codes.UnknownModel,
        },
      })
    }

    const directory = reqMeta["x-cgpt-directory"]
    if (!directory) {
      return reply.code(400).send({
        error: {
          message:
            "Missing X-CGPT-Directory header: the bridge requires OpenCode runtime metadata. Install the bridge plugin with `cgpt opencode install`, or pass X-CGPT-Directory / X-CGPT-Session-ID headers manually.",
          type: "invalid_request_error",
          code: Codes.MissingMetadata,
        },
      })
    }

    let result
    try {
      result = await turns.handle(
        { model: req.model, messages: req.messages as ChatMessage[], tools: req.tools ?? [] },
        {
          sessionId: reqMeta["x-cgpt-session-id"] ?? null,
          directory,
          worktree: reqMeta["x-cgpt-worktree"] ?? null,
        },
      )
    } catch (err) {
      return sendBridgeError(reply, err)
    }

    const id = randomId("chatcmpl")
    const created = Math.floor(Date.now() / 1000)
    const kind = result.kind
    const content = kind === "final" ? ((result.response.choices as any)[0].message.content as string) : null
    const toolCalls = kind === "tool_calls" ? toValidatedToolCalls(extractCalls(result.response)) : undefined
    const finishReason = kind === "tool_calls" ? "tool_calls" : "stop"

    if (req.stream) {
      reply.header("content-type", "text/event-stream; charset=utf-8")
      reply.header("cache-control", "no-cache")
      reply.header("connection", "keep-alive")
      reply.header("x-accel-buffering", "no")
      const chunks = buildSseChunks({
        id,
        model: req.model,
        created,
        content,
        toolCalls,
        finishReason,
        includeUsage: Boolean((req as Record<string, unknown>).stream_options !== undefined),
      })
      return reply.send(chunks.join(""))
    }

    return reply.send(result.response)
  })

  return app
}

function extractCalls(response: Record<string, unknown>): Array<{ id: string; name: string; arguments: string }> {
  const choice = (response.choices as Array<any>)?.[0]
  const calls = choice?.message?.tool_calls ?? []
  return calls.map((c: any) => ({
    id: c.id,
    name: c.function.name,
    arguments: c.function.arguments,
  }))
}

function toValidatedToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): ValidatedToolCall[] {
  return calls.map((c) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(c.arguments)
    } catch {
      args = {}
    }
    return { id: c.id, name: c.name, arguments: args }
  })
}

export function sendBridgeError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof CgptError) {
    const status =
      err.code === Codes.Unauthorized
        ? 401
        : err.code === Codes.UnknownModel
          ? 404
          : err.code === Codes.BadRequest || err.code === Codes.MissingMetadata
            ? 400
            : err.code === Codes.NotLoggedIn || err.code === Codes.ProjectUnverifiable || err.code === Codes.Unbound
              ? 409
              : err.code === Codes.ProtocolFailed
                ? 502
                : 500
    log.error("bridge error", { code: err.code })
    return reply.code(status).send({
      error: {
        message: err.message,
        type: "bridge_error",
        code: err.code,
      },
    })
  }
  log.error("unexpected error", { error: String((err as Error)?.message ?? err) })
  return reply.code(500).send({
    error: {
      message: `Unexpected bridge failure: ${String((err as Error)?.message ?? err)}`,
      type: "bridge_error",
      code: "INTERNAL",
    },
  })
}
