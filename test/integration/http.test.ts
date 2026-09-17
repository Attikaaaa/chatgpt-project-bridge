import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildServer } from "../../src/server/http.js"
import { TurnService } from "../../src/server/turn-service.js"
import { FakeChatBackend } from "../../src/browser/fake.js"
import { setBinding } from "../../src/state/workspaces.js"
import type { FastifyInstance } from "fastify"

let stateDir: string
let workDir: string
let app: FastifyInstance
let backend: FakeChatBackend
const TOKEN = "test-token-123"
const PROJECT = "https://chatgpt.com/fake/g-p-proj1"
const stateBefore = process.env.CGPT_STATE_DIR

const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
  "x-cgpt-directory": "",
  "x-cgpt-session-id": "sess-http",
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "cgpt-http-"))
  process.env.CGPT_STATE_DIR = stateDir
  workDir = join(stateDir, "ws")
  mkdirSync(workDir)
  headers["x-cgpt-directory"] = workDir
  await setBinding(workDir, PROJECT)
  backend = new FakeChatBackend([
    { respond: '{"type":"final","content":"hello from chatgpt"}' },
  ])
  const turns = new TurnService(backend)
  app = await buildServer(turns, { host: "127.0.0.1", port: 0, token: TOKEN })
  await app.listen({ port: 0, host: "127.0.0.1" })
})

afterAll(async () => {
  await app.close()
  backend.close()
  if (stateBefore === undefined) delete process.env.CGPT_STATE_DIR
  else process.env.CGPT_STATE_DIR = stateBefore
  rmSync(stateDir, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${(app.server.address() as any).port}`

const body = {
  model: "chatgpt-project-web",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ],
}

describe("G07 raw provider surface", () => {
  it("GET /health is unauthenticated and leaks nothing", async () => {
    const res = await fetch(`${base()}/health`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true })
    const text = await (await fetch(`${base()}/health`)).text()
    expect(text.toLowerCase()).not.toContain("auth")
  })

  it("GET /v1/models requires auth", async () => {
    const noAuth = await fetch(`${base()}/v1/models`)
    expect(noAuth.status).toBe(401)
    const badAuth = await fetch(`${base()}/v1/models`, { headers: { authorization: "Bearer nope" } })
    expect(badAuth.status).toBe(401)
    const ok = await fetch(`${base()}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(ok.status).toBe(200)
    const json = await ok.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].id).toBe("chatgpt-project-web")
  })

  it("POST chat/completions: non-stream text response", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: false }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.choices[0].message.content).toBe("hello from chatgpt")
    expect(json.choices[0].finish_reason).toBe("stop")
    expect(json.usage).toBeUndefined() // no fabricated token accounting
  })

  it("POST chat/completions: stream SSE response", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: true }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("data: ")
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
    // assemble content from frames
    const frames = text.split("\n\n").filter((f) => f.startsWith("data: ") && !f.includes("[DONE]"))
    let content = ""
    let role = ""
    for (const f of frames) {
      const json = JSON.parse(f.slice(6))
      if (json.choices?.[0]?.delta?.role) role = json.choices[0].delta.role
      if (typeof json.choices?.[0]?.delta?.content === "string") content += json.choices[0].delta.content
    }
    expect(role).toBe("assistant")
    expect(content).toBe("hello from chatgpt")
  })

  it("invalid auth rejected on chat/completions", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer invalid" },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(401)
  })

  it("unknown model rejected with 404", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: "gpt-4o" }),
    })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error.message).toContain("chatgpt-project-web")
  })

  it("malformed request rejected with 400", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "chatgpt-project-web", messages: "not-an-array" }),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.type).toBe("invalid_request_error")
  })

  it("missing directory header → fail closed with actionable error", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, "x-cgpt-directory": "" },
      body: JSON.stringify(body),
    })
    expect([400, 409]).toContain(res.status)
    const json = await res.json()
    expect(json.error.message).toContain("X-CGPT-Directory")
  })

  it("unbound workspace → fail closed, never routes to another project", async () => {
    const startsBefore = backend.starts.length
    const other = join(stateDir, "unbound-ws")
    mkdirSync(other)
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, "x-cgpt-directory": other },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error.code).toBe("UNBOUND_WORKSPACE")
    expect(json.error.message).toContain("cgpt bind")
    expect(backend.starts.length).toBe(startsBefore)
  })
})

describe("session routing over HTTP", () => {
  beforeEach(() => {
    backend.reset()
    backend.script = [{ respond: '{"type":"final","content":"resp"}' }]
  })

  it("same session id → one conversation; different session id → new conversation", async () => {
    const call = (session: string) =>
      fetch(`${base()}/v1/chat/completions`, {
        method: "POST",
        headers: { ...headers, "x-cgpt-session-id": session },
        body: JSON.stringify(body),
      }).then((r) => r.json())

    await call("sessA")
    await call("sessA")
    await call("sessB")
    // two conversations total: sessA's + sessB's
    expect(backend.starts).toHaveLength(2)
    expect(backend.conversations.size).toBe(2)
  })

  it("G12-style: session A and B responses do not cross contaminate", async () => {
    backend.reset()
    const seq = new Map<string, number>()
    backend.script = [
      { match: /alpha/, respond: '{"type":"final","content":"alpha-1"}' },
      { match: /beta/, respond: '{"type":"final","content":"beta-1"}' },
      { respond: '{"type":"final","content":"catchall"}' },
    ]
    const call = (session: string, text: string) =>
      fetch(`${base()}/v1/chat/completions`, {
        method: "POST",
        headers: { ...headers, "x-cgpt-session-id": session },
        body: JSON.stringify({
          model: "chatgpt-project-web",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: text },
          ],
        }),
      }).then((r) => r.json())

    const a = await call("sessA2", "about alpha")
    const b = await call("sessB2", "about beta")
    expect(a.choices[0].message.content).toBe("alpha-1")
    expect(b.choices[0].message.content).toBe("beta-1")
    // conversation A received only alpha-related messages
    const convs = [...backend.conversations.values()]
    const convA = convs.find((c) => c.transcript.some((t) => t.text.includes("about alpha")))
    const convB = convs.find((c) => c.transcript.some((t) => t.text.includes("about beta")))
    expect(convA).toBeDefined()
    expect(convB).toBeDefined()
    expect(convA!.id).not.toBe(convB!.id)
    expect(convA!.transcript.some((t) => t.text.includes("about beta"))).toBe(false)
    expect(convB!.transcript.some((t) => t.text.includes("about alpha"))).toBe(false)
  })
})
