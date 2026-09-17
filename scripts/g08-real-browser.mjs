#!/usr/bin/env node
/**
 * G08 (real-model variant): 5 sequential tool-call round trips against the
 * REAL ChatGPT web UI using the bridge transport protocol. Proves the model
 * understands the protocol, returns parseable tool calls, and correlates
 * tool results across turns. Uses the anonymous UI when unauthenticated
 * (Projects are not needed for protocol mechanics).
 */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"
import { submitPrompt, awaitResponseCompletion } from "../dist/browser/completion.js"
import { parseTransportResponse } from "../dist/chatgpt/protocol.js"
import {
  TRANSPORT_PROMPT,
  RESPOND_NOW,
  renderToolManifest,
  renderToolResults,
} from "../dist/chatgpt/transport.js"

const manifest = [
  {
    name: "read_file",
    description: "Read a file from the workspace. Returns the file content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "relative file path" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List entries of a directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
]

// Deterministic fixture: 5 files with secret numbers.
const FILES = {
  "one.txt": "SECRET_ONE=11111",
  "two.txt": "SECRET_TWO=22222",
  "three.txt": "SECRET_THREE=33333",
  "four.txt": "SECRET_FOUR=44444",
  "five.txt": "SECRET_FIVE=55555",
}

const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = { headless: false, viewport: { width: 1440, height: 900 } }
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 })
await page.waitForTimeout(5_000)

let before = 0
async function send(message, timeoutMs = 180_000) {
  const submit = await submitPrompt(page, message, 30_000)
  const completion = await awaitResponseCompletion(page, submit.beforeAssistant, timeoutMs, 2)
  return completion.text
}

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

try {
  // Bootstrap turn
  const bootstrap = [
    TRANSPORT_PROMPT,
    renderToolManifest(manifest),
    `[USER]\nRead one.txt through five.txt one at a time (one file per turn), then report all five SECRET values in order.`,
    RESPOND_NOW,
  ].join("\n\n")
  const firstRaw = await send(bootstrap)
  console.log(JSON.stringify({ turn: "bootstrap", raw: firstRaw.slice(0, 200) }))

  let ok = true
  for (let i = 1; i <= 5; i++) {
    const parsed = parseTransportResponse(firstRaw, manifest)
    // Each turn: send the tool result for the requested file, await next action.
    const parsed2 = parseTransportResponse(i === 1 ? firstRaw : prevRaw, manifest)
    if (!parsed2.ok || parsed2.kind !== "tool_calls") {
      record(`roundtrip-${i}`, false, `expected tool_calls, got: ${JSON.stringify(parsed2).slice(0, 200)}`)
      ok = false
      break
    }
    const call = parsed2.calls[0]
    const fileName = call.arguments.path
    const content = FILES[fileName]
    const resultMsg = [
      renderToolResults([
        { id: call.id, name: call.name, content: content ?? "(file not found)", isError: content === undefined },
      ]),
      RESPOND_NOW,
    ].join("\n\n")
    const raw = await send(resultMsg)
    console.log(JSON.stringify({ turn: i, toolCall: call.name, args: call.arguments }))
    if (i === 5) {
      // after the 5th file, model should produce final with all 5 secrets
      const finalParsed = parseTransportResponse(raw, manifest)
      if (finalParsed.ok && finalParsed.kind === "final") {
        const allFound = Object.values(FILES).every((s) => finalParsed.content.includes(s.split("=")[1]))
        record("roundtrips", true, `5 tool round trips completed`)
        record("final-answer", allFound, `final content: ${finalParsed.content.slice(0, 200)}`)
        ok = allFound
      } else {
        record("final-answer", false, `not a final: ${JSON.stringify(finalParsed).slice(0, 200)}`)
        ok = false
      }
    }
    var prevRaw = raw
  }

  await ensureDir("proof/private")
  await page.screenshot({ path: "proof/private/g08-real-browser.png" })

  // Write proof
  const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs")
  const { join, dirname } = await import("node:path")
  const root = dirname(dirname(new URL(import.meta.url).pathname))
  mkdirSync(join(root, "proof"), { recursive: true })
  const proofPath = join(root, "proof/feasibility.json")
  let proof = {}
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"))
  } catch {}
  proof.timestamp = new Date().toISOString()
  proof.gates = proof.gates ?? {}
  proof.gates.G08_REAL_BROWSER = {
    status: ok ? "PASS" : "FAIL",
    note: "Real ChatGPT web model executing the bridge transport protocol (anonymous UI, no Project). Project-bound G08 covered by fake-backend unit tests.",
    evidence: results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
    command: "node scripts/g08-real-browser.mjs",
  }
  proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
  writeFileSync(proofPath, JSON.stringify(proof, null, 2))
  console.log(`\nG08(real-browser) ${ok ? "PASS" : "FAIL"}`)
  process.exitCode = ok ? 0 : 1
} catch (e) {
  await page.screenshot({ path: "proof/private/g08-failure.png" }).catch(() => {})
  console.log(JSON.stringify({ error: e.message, url: page.url() }))
  process.exitCode = 1
} finally {
  await ctx.close()
}
