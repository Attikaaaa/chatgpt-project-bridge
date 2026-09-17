#!/usr/bin/env node
/**
 * G16 — UI FAILURE. Proves actionable, fail-closed errors for:
 *  - missing prompt composer (real browser on a non-ChatGPT page path)
 *  - unresumable conversation (fake backend: deleted conversation)
 *  - browser-side send failure (fake backend: sendFailure)
 *  - project verification failure (fake backend: projectFailure)
 * The bridge must never send a prompt to an unknown page.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { TurnService } from "../dist/server/turn-service.js"
import { FakeChatBackend } from "../dist/browser/fake.js"
import { setBinding } from "../dist/state/workspaces.js"
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { isComposerVisible } from "../dist/browser/completion.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const stateDir = mkdtempSync(join(tmpdir(), "g16-"))
const workDir = join(stateDir, "ws")
mkdirSync(workDir)
process.env.CGPT_STATE_DIR = stateDir
await setBinding(workDir, "https://chatgpt.com/fake/g-p-gate16")

const request = {
  model: "chatgpt-project-web",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ],
  tools: [],
}
const meta = { sessionId: "g16-session", directory: workDir, worktree: workDir }

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

// 1. Missing composer on a real browser: navigate to example.com, verify
// composer detection fails (the backend refuses to start conversations there).
{
  const discovered = await discoverBrowser({})
  const opts = { headless: true, viewport: { width: 1280, height: 800 } }
  if (discovered.executablePath) opts.executablePath = discovered.executablePath
  else if (discovered.channel) opts.channel = discovered.channel
  const ctx = await chromium.launchPersistentContext(join(browserProfileDir(), "g16-probe"), opts)
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30_000 })
  const composerVisible = await isComposerVisible(page, 3_000)
  record("no-composer-on-foreign-page", composerVisible === false, `composer visible=${composerVisible} on ${page.url()}`)
  await ctx.close()
}

// 2. Unresumable conversation → TurnService resyncs into a new conversation.
{
  const backend = new FakeChatBackend([
    { respond: '{"type":"final","content":"first"}' },
    { respond: '{"type":"final","content":"after-resync"}' },
  ])
  const svc = new TurnService(backend)
  await svc.handle(request, meta)
  const convId = [...backend.conversations.keys()][0]
  backend.conversations.delete(convId) // conversation disappears
  const out = await svc.handle(request, meta)
  record(
    "unresumable-conversation-resyncs",
    backend.starts.length === 2 && out.response.choices[0].message.content === "after-resync",
    `starts=${backend.starts.length} content=${out.response.choices[0].message.content}`,
  )
}

// 3. Browser send failure surfaces as an error (no silent success).
{
  const backend = new FakeChatBackend([{ respond: '{"type":"final","content":"x"}' }])
  backend.sendFailure = "simulated browser crash"
  const svc = new TurnService(backend)
  let failed = false
  try {
    await svc.handle(request, meta)
  } catch (e) {
    failed = true
    record("send-failure-actionable", String(e.message).includes("simulated browser crash"), e.message.slice(0, 100))
  }
  if (!failed) record("send-failure-actionable", false, "no error raised")
}

// 4. Project verification failure → fail closed, zero prompts submitted.
{
  const backend = new FakeChatBackend([{ respond: '{"type":"final","content":"x"}' }])
  backend.projectFailure = "composer missing on project page"
  const svc = new TurnService(backend)
  let failed = false
  try {
    await svc.handle(request, meta)
  } catch (e) {
    failed = true
    record(
      "project-unverifiable-fails-closed",
      String(e.message).includes("could not be verified") && String(e.message).includes("No prompt was submitted"),
      e.message.slice(0, 140),
    )
  }
  if (!failed) record("project-unverifiable-fails-closed", false, "no error raised")
  record("no-prompts-when-project-unverified", backend.sends.length === 0, `sends=${backend.sends.length}`)
}

const allPass = results.every((r) => r.pass)
const proofPath = join(root, "proof/feasibility.json")
let proof = {}
try {
  proof = JSON.parse(readFileSync(proofPath, "utf8"))
} catch {}
proof.timestamp = new Date().toISOString()
proof.gates = proof.gates ?? {}
proof.gates.G16 = {
  status: allPass ? "PASS" : "FAIL",
  evidence: results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
  command: "node scripts/g16-ui-failure.mjs",
}
proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
writeFileSync(proofPath, JSON.stringify(proof, null, 2))
console.log(`\nG16 ${allPass ? "PASS" : "FAIL"}`)
process.exit(allPass ? 0 : 1)
