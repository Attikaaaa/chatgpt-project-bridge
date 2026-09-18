#!/usr/bin/env node
/**
 * Runs every automatable gate and writes proof/feasibility.json.
 * Gates requiring an authenticated ChatGPT profile (G02, G03, G04, G05, G06)
 * are marked BLOCKED with reproduction instructions until `cgpt login`
 * + `cgpt bind` have been completed; rerun this script afterwards.
 */
import { execSync, spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const proofPath = join(root, "proof/feasibility.json")

function run(cmd) {
  const r = spawnSync("node", cmd, { cwd: root, encoding: "utf8", timeout: 900_000 })
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") }
}

// deterministic + fake-backend gates
const gates = [
  ["G01", ["scripts/g01-environment.mjs"]],
  ["G07", ["scripts/g07-raw-provider.mjs"]],
  ["G15", ["scripts/g15-malformed.mjs"]],
  ["G16", ["scripts/g16-ui-failure.mjs"]],
  ["G17", ["scripts/g17-divergence.mjs"]],
  ["G14", ["scripts/g14-restart.mjs"]],
]

// real-model + real-OpenCode gates
gates.push(["G08_REAL_BROWSER", ["scripts/g08-real-browser.mjs"]])
gates.push(["G09_G13_G18_OPENCODE_SIDE", ["scripts/e2e-opencode.mjs"]])

const summary = []
for (const [name, cmd] of gates) {
  const r = run(cmd)
  const lines = r.out.split("\n").filter((l) => /^(PASS|FAIL) /.test(l))
  summary.push({ name, code: r.code, checks: lines })
  console.log(`${r.code === 0 ? "PASS" : "FAIL"} ${name} (${cmd[0]})`)
  if (r.code !== 0) console.log(r.out.split("\n").slice(-25).join("\n"))
}

// auth-gated gates
let proof = {}
try {
  proof = JSON.parse(readFileSync(proofPath, "utf8"))
} catch {}

// Probe auth state to decide G02/G03 statuses
const authProbe = spawnSync("node", ["scripts/probe-auth.mjs"], { cwd: root, encoding: "utf8", timeout: 180_000 })
const authed = /"authenticated": true/.test(authProbe.stdout?.toString() ?? "")
proof.gates = proof.gates ?? {}
if (authed) {
  console.log("Authenticated profile detected — run the project-bound gates (scripts/g03-project-routing.mjs, scripts/g04-g06-canaries.mjs) with a bound Project.")
} else {
  for (const id of ["G02", "G03", "G04", "G05", "G06"]) {
    proof.gates[id] = {
      status: "BLOCKED",
      note: "Requires an authenticated ChatGPT browser profile (and a bound Project for G03–G06).",
      reproduction: [
        "node dist/cli/index.js login        # log in inside the opened window",
        "cd /path/to/your/repo && node dist/cli/index.js bind <project-url>",
        "node scripts/proof-all.mjs          # rerun",
      ],
    }
  }
}

proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS")
  ? "PASS"
  : Object.values(proof.gates).some((g) => g.status === "FAIL")
    ? "FAIL"
    : "PARTIAL"
writeFileSync(proofPath, JSON.stringify(proof, null, 2))
console.log(`\noverall: ${proof.overall} — proof/feasibility.json`)
