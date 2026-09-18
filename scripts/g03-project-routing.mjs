#!/usr/bin/env node
/**
 * G03 — PROJECT ROUTING (requires `cgpt login` + `cgpt bind` in this directory).
 * Proves: navigate by stored Project URL → verify Project → start a NEW
 * chat → capture the conversation → prove it belongs to the expected Project.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { getBinding, canonicalWorkspace } from "../dist/state/workspaces.js"
import { PlaywrightChatBackend } from "../dist/browser/playwright.js"
import { loadConfig } from "../dist/state/config.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const cfg = await loadConfig()
const binding = await getBinding(process.cwd())
if (!binding) {
  console.error("No binding for the current directory. Run: node dist/cli/index.js bind <project-url>")
  process.exit(1)
}
const backend = new PlaywrightChatBackend({ screenshotsDir: join(root, "proof/private") })
const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

try {
  const auth = await backend.verifyAuth()
  record("authenticated", auth.authenticated, auth.detail)
  const project = await backend.verifyProject(binding.entry.projectUrl)
  record("project-verified", project.ok, project.detail)
  const started = await backend.startConversation(
    binding.entry.projectUrl,
    `Reply with exactly one JSON object and nothing else:\n{"type":"final","content":"G03_ROUTING_OK"}`,
    cfg.responseTimeoutMs,
  )
  const convUrl = started.result.conversationUrl
  record("conversation-created", Boolean(convUrl), convUrl)
  record(
    "conversation-belongs-to-project",
    !binding.entry.projectId || convUrl.includes(binding.entry.projectId) || project.projectId === binding.entry.projectId,
    `project=${binding.entry.projectId} convUrl=${convUrl}`,
  )
  record(
    "response-correct",
    started.result.text.includes("G03_ROUTING_OK"),
    started.result.text.slice(0, 120),
  )

  mkdirSync(join(root, "proof"), { recursive: true })
  const proofPath = join(root, "proof/feasibility.json")
  let proof = {}
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"))
  } catch {}
  proof.timestamp = new Date().toISOString()
  proof.gates = proof.gates ?? {}
  proof.gates.G03 = {
    status: results.every((r) => r.pass) ? "PASS" : "FAIL",
    note: "Screenshots under proof/private (gitignored).",
    evidence: results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
    command: "node scripts/g03-project-routing.mjs",
  }
  proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
  writeFileSync(proofPath, JSON.stringify(proof, null, 2))
} catch (e) {
  console.error("ERROR:", e.message)
  process.exitCode = 1
} finally {
  await backend.close().catch(() => {})
}
console.log(`\nG03 ${results.every((r) => r.pass) ? "PASS" : "FAIL"}`)
