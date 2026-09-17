#!/usr/bin/env node
/**
 * G17 — HISTORY DIVERGENCE. Prove safe resynchronization when the OpenCode
 * history no longer matches the bridge ledger: a NEW ChatGPT conversation
 * receives ONE canonical snapshot; the old conversation is not reused and
 * receives no duplicate full history.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { TurnService } from "../dist/server/turn-service.js"
import { FakeChatBackend } from "../dist/browser/fake.js"
import { setBinding } from "../dist/state/workspaces.js"
import { loadSession, sessionKey } from "../dist/state/sessions.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const stateDir = mkdtempSync(join(tmpdir(), "g17-"))
const workDir = join(stateDir, "ws")
mkdirSync(workDir)
process.env.CGPT_STATE_DIR = stateDir
await setBinding(workDir, "https://chatgpt.com/fake/g-p-gate17")

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

const backend = new FakeChatBackend([
  { respond: '{"type":"tool_calls","calls":[{"id":"c1","name":"read_file","arguments":{"path":"a"}}]}' },
  { respond: '{"type":"final","content":"post-resync done"}' },
])
const svc = new TurnService(backend)
const meta = { sessionId: "g17-session", directory: workDir, worktree: workDir }

// Turn 1: normal tool round trip
const req1 = {
  model: "chatgpt-project-web",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "read a" },
  ],
  tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
}
await svc.handle(req1, meta)
const firstConvId = [...backend.conversations.keys()][0]
const firstConv = backend.conversations.get(firstConvId)
const messagesInFirstConvBeforeDivergence = firstConv.transcript.length

// Turn 2: simulated compaction — history replaced by a summary
const req2 = {
  model: "chatgpt-project-web",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "SUMMARY: earlier we read file a. Continue." },
  ],
  tools: req1.tools,
}
const out = await svc.handle(req2, meta)

const secondConvId = [...backend.conversations.keys()].find((k) => k !== firstConvId)
const secondConv = backend.conversations.get(secondConvId)
const resyncMessage = secondConv.transcript[0].text

record(
  "divergence-creates-new-conversation",
  backend.starts.length === 2 && secondConvId !== firstConvId,
  `starts=${backend.starts.length}`,
)
record(
  "resync-snapshot-is-canonical",
  resyncMessage.includes("CONTEXT RESYNC") && resyncMessage.includes("SUMMARY: earlier we read file a"),
  resyncMessage.slice(0, 120).replace(/\n/g, " "),
)
record(
  "no-duplicate-full-history-in-old-conversation",
  firstConv.transcript.length === messagesInFirstConvBeforeDivergence,
  `old conversation messages before=${messagesInFirstConvBeforeDivergence} after=${firstConv.transcript.length}`,
)
record(
  "mapping-replaced",
  out.response.choices[0].message.content === "post-resync done",
  `content=${out.response.choices[0].message.content}`,
)
// stored session record now points at the new conversation
const recordKey = sessionKey(workDir, "g17-session")
const rec = await loadSession(recordKey)
record(
  "session-record-updated",
  rec.conversation.url === secondConv.url,
  `record.conversation=${rec.conversation.url.slice(0, 60)}`,
)

const allPass = results.every((r) => r.pass)
const proofPath = join(root, "proof/feasibility.json")
let proof = {}
try {
  proof = JSON.parse(readFileSync(proofPath, "utf8"))
} catch {}
proof.timestamp = new Date().toISOString()
proof.gates = proof.gates ?? {}
proof.gates.G17 = {
  status: allPass ? "PASS" : "FAIL",
  evidence: results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
  command: "node scripts/g17-divergence.mjs",
}
proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
writeFileSync(proofPath, JSON.stringify(proof, null, 2))
console.log(`\nG17 ${allPass ? "PASS" : "FAIL"}`)
process.exit(allPass ? 0 : 1)
