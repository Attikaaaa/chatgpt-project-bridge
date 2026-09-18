#!/usr/bin/env node
/**
 * Standalone daemon with a FAKE ChatGPT backend for deterministic tests and
 * real-OpenCode E2E runs (the OpenCode side is real; the ChatGPT side is a
 * deterministic script). Not part of the product surface.
 *
 * Bindings: env CGPT_BINDINGS="dir1=url1,dir2=url2" (all bound to fake projects)
 * Capture:  env CGPT_CAPTURE_PATH=...  CGPT_CAPTURE_TOOLS_PATH=...
 * Usage: node scripts/fake-daemon.mjs <port> <token> [workspace-dir] [script-json-path]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildServer } from "../dist/server/http.js"
import { TurnService } from "../dist/server/turn-service.js"
import { FakeChatBackend } from "../dist/browser/fake.js"
import { setBinding } from "../dist/state/workspaces.js"
import { rotateToken } from "../dist/security/auth.js"

const [portArg, tokenArg, workspaceArg, scriptArg] = process.argv.slice(2)
const port = Number(portArg ?? 3210)
const token = tokenArg ?? (await rotateToken())
const script = scriptArg ? JSON.parse(readFileSync(scriptArg, "utf8")) : []

const stateDir = mkdtempSync(join(tmpdir(), "cgpt-fake-daemon-"))
process.env.CGPT_STATE_DIR = stateDir

// bindings: default single workspace; CGPT_BINDINGS adds more
const bindings = []
if (workspaceArg) {
  const ws = resolve(workspaceArg)
  mkdirSync(ws, { recursive: true })
  await setBinding(ws, "https://chatgpt.com/fake/g-p-gate07")
  bindings.push({ workspace: ws, projectUrl: "https://chatgpt.com/fake/g-p-gate07" })
}
const extra = process.env.CGPT_BINDINGS ?? ""
for (const pair of extra.split(",").filter(Boolean)) {
  const [dir, url] = pair.split("=")
  const ws = resolve(dir)
  mkdirSync(ws, { recursive: true })
  await setBinding(ws, url)
  bindings.push({ workspace: ws, projectUrl: url })
}

const backend = new FakeChatBackend(script)
const turns = new TurnService(backend)
const app = await buildServer(turns, { host: "127.0.0.1", port, token })

// Optional request-shape capture for test/fixtures/opencode.
const capturePath = process.env.CGPT_CAPTURE_PATH
const captureToolsPath = process.env.CGPT_CAPTURE_TOOLS_PATH
if (captureToolsPath) {
  const { writeFileSync } = await import("node:fs")
  let dumped = false
  app.addHook("preHandler", async (request) => {
    if (dumped || request.url !== "/v1/chat/completions" || request.method !== "POST") return
    const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body
    if (body.tools?.length) {
      dumped = true
      writeFileSync(captureToolsPath, JSON.stringify(body.tools, null, 2))
    }
  })
}
if (process.env.CGPT_BODY_LOG) {
  const { appendFileSync } = await import("node:fs")
  app.addHook("preHandler", async (request) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") return
    const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body
    const last = body.messages?.at(-1)
    appendFileSync(
      process.env.CGPT_BODY_LOG,
      `=== ${request.headers["x-cgpt-session-id"]?.slice(0, 12)} dir=${(request.headers["x-cgpt-directory"] ?? "").split("/").pop()} roles=${body.messages?.map((m) => m.role).join(",")} ===\n` +
        (typeof last?.content === "string" ? last.content.slice(0, 1500) : JSON.stringify(last?.content ?? "").slice(0, 800)) + "\n",
    )
  })
}
if (capturePath) {
  const { writeFileSync } = await import("node:fs")
  let n = 0
  app.addHook("preHandler", async (request) => {
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") return
    n++
    const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body
    const sanitized = {
      capturedAt: new Date().toISOString(),
      url: request.url,
      headerNames: Object.keys(request.headers).sort(),
      hasAuthorization: "authorization" in request.headers,
      metadataHeaders: {
        sessionId: request.headers["x-cgpt-session-id"] ?? null,
        directory: request.headers["x-cgpt-directory"] ?? null,
        worktree: request.headers["x-cgpt-worktree"] ?? null,
      },
      bodyShape: {
        model: body.model,
        stream: body.stream ?? false,
        messageCount: body.messages?.length,
        roles: body.messages?.map((m) => m.role),
        toolNames: body.tools?.map((t) => t.function?.name) ?? [],
        toolChoice: body.tool_choice ?? null,
        extraTopLevelKeys: Object.keys(body).filter((k) => !["model", "messages", "tools", "tool_choice", "stream", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream_options"].includes(k)),
      },
      firstToolSample: body.tools?.[0]
        ? {
            name: body.tools[0].function?.name,
            parameters: body.tools[0].function?.parameters,
          }
        : null,
      firstMessageContentSample:
        typeof body.messages?.[0]?.content === "string" ? body.messages[0].content.slice(0, 400) : "(parts)",
    }
    writeFileSync(capturePath.replace(".json", `-${n}.json`), JSON.stringify(sanitized, null, 2))
  })
}

await app.listen({ port, host: "127.0.0.1" })
writeFileSync(join(stateDir, "daemon.json"), JSON.stringify({ port, workspace: workspaceArg ?? null, bindings }))

console.log(JSON.stringify({ ready: true, port, bindings, stateDir }))
process.on("SIGTERM", async () => {
  await app.close()
  process.exit(0)
})
