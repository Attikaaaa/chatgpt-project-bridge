#!/usr/bin/env node
/**
 * G14 — BRIDGE RESTART. Complete a turn, destroy the TurnService/backend
 * (simulating daemon restart), build fresh instances, continue the SAME
 * OpenCode session: the correct stored ChatGPT conversation must be resumed
 * (no new conversation started).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { TurnService } from "../dist/server/turn-service.js"
import { FakeChatBackend } from "../dist/browser/fake.js"
import { setBinding } from "../dist/state/workspaces.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const stateDir = mkdtempSync(join(tmpdir(), "g14-"))
const workDir = join(stateDir, "ws")
mkdirSync(workDir)
process.env.CGPT_STATE_DIR = stateDir
await setBinding(workDir, "https://chatgpt.com/fake/g-p-gate14")

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

const request = (user) => ({
  model: "chatgpt-project-web",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: user },
  ],
  tools: [],
})
const meta = { sessionId: "g14-session", directory: workDir, worktree: workDir }

// --- "daemon" instance 1
const backend1 = new FakeChatBackend([{ respond: '{"type":"final","content":"turn-one-answer"}' }])
const svc1 = new TurnService(backend1)
await svc1.handle(request("first request"), meta)
const convId = [...backend1.conversations.keys()][0]
record("first-turn-completed", backend1.sends.length === 1, `sends=${backend1.sends.length}`)

// --- daemon restart: state survives on disk; new backend instance has NO
// in-memory queue state (like a fresh browser process) — but ChatGPT's
// server-side conversations persist, so carry them over (real-world model).
const backend2 = new FakeChatBackend([{ respond: '{"type":"final","content":"turn-two-answer"}' }])
for (const [id, conv] of backend1.conversations) backend2.conversations.set(id, conv)
const svc2 = new TurnService(backend2)
const out = await svc2.handle(
  {
    model: "chatgpt-project-web",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "first request" },
      { role: "assistant", content: "turn-one-answer" },
      { role: "user", content: "second request" },
    ],
    tools: [],
  },
  meta,
)

record(
  "no-new-conversation-after-restart",
  backend2.starts.length === 0,
  `starts=${backend2.starts.length} (must be 0 — conversation resumed from disk)`,
)
record(
  "same-conversation-resumed",
  out.response.choices[0].message.content === "turn-two-answer",
  `content=${out.response.choices[0].message.content}`,
)
record(
  "conversation-history-continued",
  backend2.conversations.get(convId)?.transcript.length === 4,
  `transcript entries=${backend2.conversations.get(convId)?.transcript.length} (2 from before restart + 2 new)`,
)
record(
  "delta-only-send-after-restart",
  backend2.sends.length === 1 && !backend2.sends[0].message.includes("first request") && backend2.sends[0].message.includes("second request"),
  `resend contained full history: ${backend2.sends[0]?.message.includes("first request")}`,
)

const allPass = results.every((r) => r.pass)
const proofPath = join(root, "proof/feasibility.json")
let proof = {}
try {
  proof = JSON.parse(readFileSync(proofPath, "utf8"))
} catch {}
proof.timestamp = new Date().toISOString()
proof.gates = proof.gates ?? {}
proof.gates.G14 = {
  status: allPass ? "PASS" : "FAIL",
  note: "Restart simulated with fresh backend instances + persisted session state. Real-daemon restart covered by same code path (atomic state files).",
  evidence: results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
  command: "node scripts/g14-restart.mjs",
}
proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
writeFileSync(proofPath, JSON.stringify(proof, null, 2))
console.log(`\nG14 ${allPass ? "PASS" : "FAIL"}`)
process.exit(allPass ? 0 : 1)
