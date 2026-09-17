#!/usr/bin/env node
/**
 * G07 — RAW PROVIDER gate.
 * Starts the fake-backend daemon and proves via real HTTP:
 *  - non-stream text response
 *  - stream text response (SSE)
 *  - invalid auth rejected (401)
 *  - unknown model rejected (404)
 *  - malformed request rejected (400)
 * Appends evidence to proof/feasibility.json via the shared helper.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const port = 13210
const token = "g07-local-test-token"
const workspace = mkdtempSync(join(tmpdir(), "g07-ws-"))

const script = [{ respond: '{"type":"final","content":"hello from the bridge"}' }]
const scriptPath = join(workspace, "script.json")
writeFileSync(scriptPath, JSON.stringify(script))

const daemon = spawn("node", [join(root, "scripts/fake-daemon.mjs"), String(port), token, workspace, scriptPath], {
  stdio: ["ignore", "pipe", "pipe"],
})
let ready = false
daemon.stdout.on("data", (d) => {
  if (String(d).includes('"ready"')) ready = true
})
for (let i = 0; i < 100 && !ready; i++) await new Promise((r) => setTimeout(r, 100))
if (!ready) {
  console.error("daemon did not start")
  process.exit(1)
}
const base = `http://127.0.0.1:${port}`
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
  "x-cgpt-directory": workspace,
  "x-cgpt-session-id": "g07-session",
}
const body = {
  model: "chatgpt-project-web",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "say hello" },
  ],
}

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

try {
  // 1. non-stream
  let res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: false }),
  })
  let json = await res.json()
  record(
    "non-stream",
    res.status === 200 && json.choices?.[0]?.message?.content === "hello from the bridge" && json.choices?.[0]?.finish_reason === "stop",
    `status=${res.status} content=${JSON.stringify(json.choices?.[0]?.message?.content)}`,
  )

  // 2. stream
  res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true }),
  })
  const text = await res.text()
  const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream")
  let content = ""
  for (const frame of text.split("\n\n")) {
    if (!frame.startsWith("data: ") || frame.includes("[DONE]")) continue
    const parsed = JSON.parse(frame.slice(6))
    const delta = parsed.choices?.[0]?.delta?.content
    if (typeof delta === "string") content += delta
  }
  record(
    "stream",
    res.status === 200 && isSse && content === "hello from the bridge" && text.trimEnd().endsWith("data: [DONE]"),
    `status=${res.status} sse=${isSse} assembled=${JSON.stringify(content)}`,
  )

  // 3. invalid auth
  res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...headers, authorization: "Bearer wrong-token" },
    body: JSON.stringify(body),
  })
  record("invalid-auth", res.status === 401, `status=${res.status}`)

  // 4. unknown model
  res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, model: "gpt-4o" }),
  })
  json = await res.json()
  record("unknown-model", res.status === 404 && /chatgpt-project-web/.test(json.error?.message ?? ""), `status=${res.status}`)

  // 5. malformed request
  res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "chatgpt-project-web" }),
  })
  record("malformed-request", res.status === 400, `status=${res.status}`)

  // 6. unauthenticated /v1/models
  res = await fetch(`${base}/v1/models`)
  record("models-auth", res.status === 401, `status=${res.status}`)

  // 7. health
  res = await fetch(`${base}/health`)
  json = await res.json()
  record("health", res.status === 200 && json.ok === true, `status=${res.status}`)
} finally {
  daemon.kill("SIGTERM")
}

const allPass = results.every((r) => r.pass)
const proofDir = join(root, "proof")
mkdirSync(proofDir, { recursive: true })
const proofPath = join(proofDir, "feasibility.json")
let proof = { gates: {} }
try {
  proof = JSON.parse(readFileSync(proofPath, "utf8"))
} catch {}
proof.timestamp = new Date().toISOString()
proof.environment = {
  node: process.version,
  os: `${process.platform} ${process.arch}`,
}
proof.gates = proof.gates ?? {}
proof.gates.G07 = {
  status: allPass ? "PASS" : "FAIL",
  evidence: results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
  command: "node scripts/g07-raw-provider.mjs",
}
proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
writeFileSync(proofPath, JSON.stringify(proof, null, 2))
console.log(`\nG07 ${allPass ? "PASS" : "FAIL"} — proof/feasibility.json updated`)
process.exit(allPass ? 0 : 1)
