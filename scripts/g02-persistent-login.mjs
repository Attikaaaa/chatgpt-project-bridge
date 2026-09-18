#!/usr/bin/env node
/** G02 — PERSISTENT LOGIN (requires manual login in the opened window).
 * 1. opens the dedicated profile browser, 2. waits for manual login,
 * 3. closes, 4. relaunches, 5. verifies authentication persisted.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { PlaywrightChatBackend } from "../dist/browser/playwright.js"
import { loadConfig } from "../dist/state/config.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const cfg = await loadConfig()
const backend = new PlaywrightChatBackend({ screenshotsDir: join(root, "proof/private") })
const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

try {
  console.log("Opening the dedicated browser profile — log in to ChatGPT in the visible window…")
  const waited = await backend.waitForInteractiveLogin(15 * 60_000)
  record("login-completed", waited.authenticated, waited.detail)
  await backend.close()
  const backend2 = new PlaywrightChatBackend({ screenshotsDir: join(root, "proof/private") })
  const verify = await backend2.verifyAuth()
  await backend2.close()
  record("auth-persists-across-restart", verify.authenticated, verify.detail)
} catch (e) {
  record("harness", false, e.message)
  await backend.close().catch(() => {})
} finally {
  const proofPath = join(root, "proof/feasibility.json")
  let proof = {}
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"))
  } catch {}
  proof.timestamp = new Date().toISOString()
  proof.gates = proof.gates ?? {}
  proof.gates.G02 = {
    status: results.every((r) => r.pass) ? "PASS" : "FAIL",
    evidence: results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`),
    command: "node scripts/g02-persistent-login.mjs",
  }
  proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS")
    ? "PASS"
    : Object.values(proof.gates).some((g) => g.status === "FAIL")
      ? "FAIL"
      : "PARTIAL"
  writeFileSync(proofPath, JSON.stringify(proof, null, 2))
}
console.log(`\nG02 ${results.every((r) => r.pass) ? "PASS" : "FAIL"}`)
