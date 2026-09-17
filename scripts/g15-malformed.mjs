#!/usr/bin/env node
/**
 * G15 — MALFORMED CHATGPT OUTPUT. Uses the deterministic fake backend to
 * prove: first invalid response → exactly one repair attempt; second
 * invalid response → hard failure (no tool call executed, no infinite loop).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { TurnService } from "../dist/server/turn-service.js"
import { FakeChatBackend } from "../dist/browser/fake.js"
import { setBinding } from "../dist/state/workspaces.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const stateDir = mkdtempSync(join(tmpdir(), "g15-"))
const workDir = join(stateDir, "ws")
mkdirSync(workDir)
process.env.CGPT_STATE_DIR = stateDir
await setBinding(workDir, "https://chatgpt.com/fake/g-p-gate15")

const request = {
  model: "chatgpt-project-web",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ],
  tools: [],
}
const meta = { sessionId: "g15-session", directory: workDir, worktree: workDir }

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

// Scenario A: malformed once → repair → success
{
  const backend = new FakeChatBackend([
    { respond: "I would read the file first because that seems wise." },
    { respond: '{"type":"final","content":"recovered-after-repair"}' },
  ])
  const svc = new TurnService(backend)
  const out = await svc.handle(request, meta)
  record(
    "repair-once-succeeds",
    out.response.choices[0].message.content === "recovered-after-repair",
    `content=${out.response.choices[0].message.content}`,
  )
  record(
    "repair-sent-to-same-conversation",
    backend.sends.length === 2 && backend.starts.length === 1,
    `sends=${backend.sends.length} starts=${backend.starts.length}`,
  )
  record(
    "repair-instruction-content",
    backend.sends[1].message.includes("violated the bridge transport schema"),
    backend.sends[1].message.slice(0, 80),
  )
}

// Scenario B: malformed twice → hard failure, exactly 2 sends total
{
  const backend = new FakeChatBackend([{ respond: "still just prose, no json here" }])
  const svc = new TurnService(backend)
  let failed = false
  let message = ""
  try {
    await svc.handle(request, meta)
  } catch (e) {
    failed = true
    message = e.message
  }
  record(
    "hard-failure-after-second-violation",
    failed && message.includes("invalid bridge response twice") && message.includes("No tool call was executed"),
    message.slice(0, 120),
  )
  record("no-infinite-loop", backend.sends.length === 2, `sends=${backend.sends.length} (must be exactly 2)`)
}

// Scenario C: unknown tool name → repair → unknown again → fail
{
  const backend = new FakeChatBackend([{ respond: '{"type":"tool_calls","calls":[{"id":"1","name":"definitely_not_a_tool","arguments":{}}]}' }])
  const svc = new TurnService(backend)
  let failed = false
  let message = ""
  try {
    await svc.handle(request, meta)
  } catch (e) {
    failed = true
    message = e.message
  }
  record("unknown-tool-fails-closed", failed, message.slice(0, 120))
}

const allPass = results.every((r) => r.pass)
const proofPath = join(root, "proof/feasibility.json")
let proof = {}
try {
  proof = JSON.parse(readFileSync(proofPath, "utf8"))
} catch {}
proof.timestamp = new Date().toISOString()
proof.gates = proof.gates ?? {}
proof.gates.G15 = {
  status: allPass ? "PASS" : "FAIL",
  evidence: results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
  command: "node scripts/g15-malformed.mjs",
}
proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
writeFileSync(proofPath, JSON.stringify(proof, null, 2))
console.log(`\nG15 ${allPass ? "PASS" : "FAIL"}`)
process.exit(allPass ? 0 : 1)
