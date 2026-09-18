import { describe, it, expect, beforeAll, afterAll } from "vitest"
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
const TOKEN = "conc-token"
const stateBefore = process.env.CGPT_STATE_DIR

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "cgpt-conc-"))
  process.env.CGPT_STATE_DIR = stateDir
  workDir = join(stateDir, "ws")
  mkdirSync(workDir)
  await setBinding(workDir, "https://chatgpt.com/fake/g-p-conc")
  backend = new FakeChatBackend([
    { respond: '{"type":"final","content":"resp-1"}' },
    { respond: '{"type":"final","content":"resp-2"}' },
    { respond: '{"type":"final","content":"resp-3"}' },
  ])
  const turns = new TurnService(backend)
  app = await buildServer(turns, { host: "127.0.0.1", port: 0, token: TOKEN })
  await app.listen({ port: 0, host: "127.0.0.1" })
})

afterAll(async () => {
  await app.close()
  if (stateBefore === undefined) delete process.env.CGPT_STATE_DIR
  else process.env.CGPT_STATE_DIR = stateBefore
  rmSync(stateDir, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${(app.server.address() as any).port}`
const call = (session: string, msg: string) =>
  fetch(`${base()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-cgpt-directory": workDir,
      "x-cgpt-session-id": session,
    },
    body: JSON.stringify({
      model: "chatgpt-project-web",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: msg },
      ],
    }),
  }).then((r) => r.json())

describe("concurrency", () => {
  it("serializes browser access; interleaved requests for different sessions all complete", async () => {
    const results = await Promise.all([
      call("s1", "alpha"),
      call("s2", "beta"),
      call("s3", "gamma"),
    ])
    const contents = results.map((r) => r.choices?.[0]?.message?.content).sort()
    expect(contents).toEqual(["resp-1", "resp-2", "resp-3"])
    // each session got its own conversation; no cross-contamination
    expect(backend.conversations.size).toBe(3)
    for (const conv of backend.conversations.values()) {
      const userTexts = conv.transcript.filter((t) => t.role === "user")
      expect(userTexts).toHaveLength(1)
    }
  })

  it("same session identical-history retries (provider retry) land on the same conversation", async () => {
    backend.reset()
    backend.script = [
      { respond: '{"type":"final","content":"one"}' },
      { respond: '{"type":"final","content":"two"}' },
    ]
    const sameHistory = () => ({
      model: "chatgpt-project-web",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "identical request" },
      ],
    })
    // concurrent identical requests (e.g. provider retry): the first creates
    // the conversation, the second must reuse it (delta/ledger match)
    const results = await Promise.all([call("same", "identical request"), call("same", "identical request")])
    expect(results).toHaveLength(2)
    const convs = [...backend.conversations.values()]
    expect(convs).toHaveLength(1)
    expect(convs[0].transcript.filter((t) => t.role === "user")).toHaveLength(2)
  })

  it("same session with divergent histories is resynced into a new conversation, not mixed", async () => {
    backend.reset()
    backend.script = [
      { respond: '{"type":"final","content":"one"}' },
      { respond: '{"type":"final","content":"two"}' },
    ]
    // different histories for the same session = divergence → the second
    // gets a NEW conversation (never mixed into the first)
    await call("divergent", "history A")
    await call("divergent", "history B (compacted)")
    const convs = [...backend.conversations.values()]
    expect(convs).toHaveLength(2)
    const convA = convs.find((c) => c.transcript.some((t) => t.text.includes("history A")))
    const convB = convs.find((c) => c.transcript.some((t) => t.text.includes("history B")))
    expect(convA).toBeDefined()
    expect(convB).toBeDefined()
    expect(convA!.id).not.toBe(convB!.id)
  })
})
