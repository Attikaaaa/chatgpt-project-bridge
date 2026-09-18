#!/usr/bin/env node
/**
 * G04/G05/G06 — CANARY gates (all optional, active, require manual prep).
 *
 * Manual preparation (documented in README section "Canary gates"):
 *   G04: put a unique marker in the ChatGPT Project INSTRUCTIONS, e.g.
 *        PROJECT_INSTRUCTION_CANARY_<random>
 *   G05: add a file BRIDGE_CANARY.md to the Project containing
 *        PROJECT_FILE_CANARY_<random>
 *   G06: in Chat A of the Project say: "Memory canary: MEMORY_CANARY_<random>.
 *        Remember this value." (ChatGPT Project memory may carry it to Chat B)
 *
 * Usage:
 *   node scripts/g04-g06-canaries.mjs --instruction-canary <value> --file-canary <value> --memory-canary <value>
 * Omitted canaries skip their gate. All canaries must NOT be secrets.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "../dist/util/argv.js"
import { getBinding } from "../dist/state/workspaces.js"
import { PlaywrightChatBackend } from "../dist/browser/playwright.js"
import { loadConfig } from "../dist/state/config.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const args = parseArgs(process.argv.slice(2))
const cfg = await loadConfig()
const binding = await getBinding(process.cwd())
if (!binding) {
  console.error("No binding for the current directory. Run: node dist/cli/index.js bind <project-url>")
  process.exit(1)
}

const ask = (backend, question) =>
  backend.startConversation(binding.entry.projectUrl, question, cfg.responseTimeoutMs)

const results = []
const record = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${id}/${name}: ${detail}`)
}

const backend = new PlaywrightChatBackend({ screenshotsDir: join(root, "proof/private") })
try {
  if (args["instruction-canary"]) {
    const canary = String(args["instruction-canary"])
    const started = await ask(
      backend,
      `What is the exact value of the instruction canary defined in this Project's instructions? Reply with only that value.`,
    )
    record("G04", "instruction-canary", started.result.text.includes(canary), started.result.text.slice(0, 120))
  } else {
    record("G04", "instruction-canary", false, "skipped: pass --instruction-canary <value> (set it in Project instructions first)")
  }

  if (args["file-canary"]) {
    const canary = String(args["file-canary"])
    const started = await ask(
      backend,
      `This Project contains a file BRIDGE_CANARY.md. What is the exact canary value inside it? Reply with only that value.`,
    )
    record("G05", "file-canary", started.result.text.includes(canary), started.result.text.slice(0, 120))
  } else {
    record("G05", "file-canary", false, "skipped: pass --file-canary <value> (add BRIDGE_CANARY.md to the Project first)")
  }

  if (args["memory-canary"]) {
    const canary = String(args["memory-canary"])
    // G06: a NEW chat in the same Project should (depending on ChatGPT
    // Project memory settings) be able to recall a value stored in another
    // Project chat. Observation is recorded as-is; ChatGPT memory state
    // is not controlled by the bridge.
    const started = await ask(
      backend,
      `Is there a memory canary value stored in this Project's memory? If you can recall one, reply with only that value; otherwise reply exactly NONE.`,
    )
    const recalled = started.result.text.includes(canary)
    const honestNone = /NONE/i.test(started.result.text)
    record("G06", "memory-canary", recalled || honestNone, `recalled=${recalled} honestNONE=${honestNone} response=${started.result.text.slice(0, 120)}`)
  } else {
    record("G06", "memory-canary", false, "skipped: pass --memory-canary <value> (store it in another Project chat first)")
  }

  const proofPath = join(root, "proof/feasibility.json")
  let proof = {}
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"))
  } catch {}
  proof.timestamp = new Date().toISOString()
  proof.gates = proof.gates ?? {}
  for (const id of ["G04", "G05", "G06"]) {
    const rs = results.filter((r) => r.id === id)
    if (rs.length) {
      proof.gates[id] = {
        status: rs.every((r) => r.pass) ? "PASS" : rs.some((r) => r.detail.startsWith("skipped")) ? "BLOCKED" : "FAIL",
        evidence: rs.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
        command: "node scripts/g04-g06-canaries.mjs",
      }
    }
  }
  proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS")
    ? "PASS"
    : Object.values(proof.gates).some((g) => g.status === "FAIL")
      ? "FAIL"
      : "PARTIAL"
  writeFileSync(proofPath, JSON.stringify(proof, null, 2))
} finally {
  await backend.close().catch(() => {})
}
