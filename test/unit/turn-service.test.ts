import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TurnService } from "../../src/server/turn-service.js"
import { FakeChatBackend } from "../../src/browser/fake.js"
import { setBinding } from "../../src/state/workspaces.js"
import { TEST_TOOL } from "../helpers.js"

let stateDir: string
let workDir: string
const stateBefore = process.env.CGPT_STATE_DIR
const PROJECT = "https://chatgpt.com/fake/g-p-proj1"

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "cgpt-turn-"))
  workDir = join(stateDir, "ws")
  mkdirSync(workDir)
  process.env.CGPT_STATE_DIR = stateDir
})
afterAll(() => {
  if (stateBefore === undefined) delete process.env.CGPT_STATE_DIR
  else process.env.CGPT_STATE_DIR = stateBefore
  rmSync(stateDir, { recursive: true, force: true })
})

const meta = (dir: string, session = "sess-1") => ({ sessionId: session, directory: dir, worktree: dir })

function turn1Request() {
  return {
    model: "chatgpt-project-web",
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Read the file." },
    ],
    tools: [TEST_TOOL],
  }
}

describe("TurnService with FakeChatBackend", () => {
  it("rejects missing directory metadata", async () => {
    const backend = new FakeChatBackend()
    const svc = new TurnService(backend)
    await expect(svc.handle(turn1Request(), { sessionId: "s", directory: "", worktree: null })).rejects.toThrow(
      /Missing OpenCode runtime directory/,
    )
  })

  it("fails closed on unbound workspace", async () => {
    const backend = new FakeChatBackend()
    const svc = new TurnService(backend)
    const other = join(stateDir, "unbound")
    mkdirSync(other)
    await expect(svc.handle(turn1Request(), meta(other))).rejects.toThrow(/No ChatGPT Project is bound/)
  })

  it("fails closed when not authenticated", async () => {
    const backend = new FakeChatBackend()
    backend.authenticated = false
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)
    await expect(svc.handle(turn1Request(), meta(workDir))).rejects.toThrow(/cgpt login/)
  })

  it("fails closed when project cannot be verified", async () => {
    const backend = new FakeChatBackend()
    backend.projectFailure = "composer missing"
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)
    await expect(svc.handle(turn1Request(), meta(workDir))).rejects.toThrow(/could not be verified/)
  })

  it("new session: starts one conversation, sends bootstrap with transport+manifest+delta", async () => {
    const backend = new FakeChatBackend([
      {
        respond:
          '{"type":"tool_calls","calls":[{"id":"call_1","name":"read_file","arguments":{"path":"README.md"}}]}',
      },
    ])
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)
    const out = await svc.handle(turn1Request(), meta(workDir))
    expect(out.kind).toBe("tool_calls")
    const msg = (out.response as any).choices[0].message
    expect(msg.tool_calls[0].id).toBe("call_1")
    expect(msg.tool_calls[0].function.name).toBe("read_file")
    expect((out.response as any).choices[0].finish_reason).toBe("tool_calls")

    expect(backend.starts).toHaveLength(1)
    expect(backend.starts[0].projectUrl).toBe(PROJECT)
    const sent = backend.sends[0].message
    expect(sent).toContain("You are serving as the reasoning component")
    expect(sent).toContain("CURRENT TOOL MANIFEST")
    expect(sent).toContain("You are a coding agent.")
    expect(sent).toContain("Read the file.")
    expect(sent).toContain("Respond with the JSON transport object now.")
  })

  it("second turn with tool result: reuses conversation, sends only the delta", async () => {
    const backend = new FakeChatBackend([
      { respond: '{"type":"tool_calls","calls":[{"id":"call_1","name":"read_file","arguments":{"path":"README.md"}}]}' },
      { respond: '{"type":"final","content":"The README says hello."}' },
    ])
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)

    await svc.handle(turn1Request(), meta(workDir))

    const req2 = {
      model: "chatgpt-project-web",
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Read the file." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "hello from README" },
      ],
      tools: [TEST_TOOL],
    }
    const out2 = await svc.handle(req2, meta(workDir))
    expect(out2.kind).toBe("final")
    expect((out2.response as any).choices[0].message.content).toBe("The README says hello.")

    // Same conversation reused (no second start)
    expect(backend.starts).toHaveLength(1)
    // Delta only: tool result, NOT the full history again
    const secondSend = backend.sends[1].message
    expect(secondSend).toContain("[TOOL RESULT] call_id=call_1 tool=read_file status=ok")
    expect(secondSend).toContain("hello from README")
    expect(secondSend).not.toContain("[USER]\nRead the file.") // not re-sent
    expect(secondSend).not.toContain("CURRENT TOOL MANIFEST") // tools unchanged
    expect(secondSend).toContain("Respond with the JSON transport object now.")
  })

  it("runs 5+ sequential tool round trips with correct correlation", async () => {
    const backend = new FakeChatBackend([
      { respond: '{"type":"tool_calls","calls":[{"id":"c1","name":"read_file","arguments":{"path":"1"}}]}' },
      { respond: '{"type":"tool_calls","calls":[{"id":"c2","name":"read_file","arguments":{"path":"2"}}]}' },
      { respond: '{"type":"tool_calls","calls":[{"id":"c3","name":"read_file","arguments":{"path":"3"}}]}' },
      { respond: '{"type":"tool_calls","calls":[{"id":"c4","name":"read_file","arguments":{"path":"4"}}]}' },
      { respond: '{"type":"tool_calls","calls":[{"id":"c5","name":"read_file","arguments":{"path":"5"}}]}' },
      { respond: '{"type":"final","content":"all read"}' },
    ])
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)

    let messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "read files 1..5 in order" },
    ]
    let out = await svc.handle({ model: "chatgpt-project-web", messages, tools: [TEST_TOOL] }, meta(workDir, "sess-loop"))
    for (let i = 1; i <= 5; i++) {
      expect(out.kind).toBe("tool_calls")
      const call = (out.response as any).choices[0].message.tool_calls[0]
      expect(call.id).toBe(`c${i}`)
      expect(call.function.name).toBe("read_file")
      const path = JSON.parse(call.function.arguments).path
      expect(path).toBe(String(i))
      // tool result comes back into the same conversation
      messages = [
        ...messages,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: `contents of ${path}` },
      ]
      out = await svc.handle({ model: "chatgpt-project-web", messages, tools: [TEST_TOOL] }, meta(workDir, "sess-loop"))
    }
    expect(out.kind).toBe("final")
    expect(backend.starts).toHaveLength(1)
    // each turn contained the newest tool result with matching id
    const lastSend = backend.sends.at(-1)!.message
    expect(lastSend).toContain("call_id=c5")
    expect(lastSend).toContain("contents of 5")
    expect(backend.sends).toHaveLength(6)
  })

  it("malformed output: exactly one repair attempt, then hard failure", async () => {
    const backend = new FakeChatBackend([
      { respond: "I think we should read the file first, it is important." },
      { respond: '{"type":"final","content":"recovered"}' },
    ])
    // First response malformed, repair gets valid response.
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)
    const out = await svc.handle(turn1Request(), meta(workDir, "sess-repair"))
    expect(out.kind).toBe("final")
    expect((out.response as any).choices[0].message.content).toBe("recovered")
    // repair message sent to same conversation
    expect(backend.sends).toHaveLength(2)
    expect(backend.sends[1].message).toContain("violated the bridge transport schema")
    expect(backend.starts).toHaveLength(1)
  })

  it("malformed twice: hard failure, no infinite loop", async () => {
    const backend = new FakeChatBackend([{ respond: "prose not json" }])
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)
    await expect(svc.handle(turn1Request(), meta(workDir, "sess-hardfail"))).rejects.toThrow(
      /invalid bridge response twice/,
    )
    expect(backend.sends).toHaveLength(2) // original + one repair
  })

  it("history divergence: resyncs into a NEW conversation with canonical snapshot", async () => {
    const backend = new FakeChatBackend([
      { respond: '{"type":"tool_calls","calls":[{"id":"c1","name":"read_file","arguments":{"path":"a"}}]}' },
      { respond: '{"type":"final","content":"resynced answer"}' },
    ])
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)

    await svc.handle(turn1Request(), meta(workDir, "sess-resync"))
    expect(backend.starts).toHaveLength(1)

    // Simulate compaction: history replaced with a summary → prefix mismatch
    const compacted = {
      model: "chatgpt-project-web",
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "SUMMARY: earlier we read files. Now continue." },
      ],
      tools: [TEST_TOOL],
    }
    const out = await svc.handle(compacted, meta(workDir, "sess-resync"))
    expect(out.kind).toBe("final")
    expect(backend.starts).toHaveLength(2) // new conversation created
    const snapshot = backend.sends[1].message
    expect(snapshot).toContain("CONTEXT RESYNC")
    expect(snapshot).toContain("SUMMARY: earlier we read files")
  })

  it("assistant messages from other providers are included in deltas", async () => {
    const backend = new FakeChatBackend([
      { respond: '{"type":"tool_calls","calls":[{"id":"c1","name":"read_file","arguments":{"path":"a"}}]}' },
      { respond: '{"type":"final","content":"ok"}' },
    ])
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)

    await svc.handle(turn1Request(), meta(workDir, "sess-foreign"))
    // Second turn where the assistant message came from elsewhere (different args than produced)
    const req2 = {
      model: "chatgpt-project-web",
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Read the file." },
        { role: "assistant", content: "I already answered in a different model." },
        { role: "user", content: "and now this" },
      ],
      tools: [TEST_TOOL],
    }
    await svc.handle(req2, meta(workDir, "sess-foreign"))
    const secondSend = backend.sends[1].message
    expect(secondSend).toContain("[ASSISTANT (from OpenCode history, not produced by you)]")
    expect(secondSend).toContain("I already answered in a different model.")
  })

  it("resumed session with deleted conversation resyncs safely", async () => {
    const backend = new FakeChatBackend([
      { respond: '{"type":"final","content":"first"}' },
      { respond: '{"type":"final","content":"resync-ok"}' },
    ])
    const svc = new TurnService(backend)
    await setBinding(workDir, PROJECT)
    await svc.handle(turn1Request(), meta(workDir, "sess-gone"))
    // Simulate conversation disappearing
    const convId = [...backend.conversations.keys()][0]
    backend.conversations.delete(convId)
    const out = await svc.handle(
      {
        model: "chatgpt-project-web",
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "Read the file." },
          { role: "assistant", content: "first" },
          { role: "user", content: "continue" },
        ],
        tools: [TEST_TOOL],
      },
      meta(workDir, "sess-gone"),
    )
    expect(out.kind).toBe("final")
    expect((out.response as any).choices[0].message.content).toBe("resync-ok")
    expect(backend.starts).toHaveLength(2)
  })
})
