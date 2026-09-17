#!/usr/bin/env node
/** G01 — ENVIRONMENT gate: record versions and toolchain availability. */
import { spawnSync } from "node:child_process"
import { writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverBrowser } from "../dist/browser/launch.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : `NOT AVAILABLE (${r.status})`
}

const nodeVer = process.version
const npmVer = sh("npm", ["--version"])
const opencodeVer = sh("opencode", ["--version"])
const gitVer = sh("git", ["--version"])
const browser = await discoverBrowser({})
const tscVer = sh("npx", ["tsc", "--version"])
const vitestVer = sh("npx", ["vitest", "--version"])

const checks = [
  { name: "node >= 22", pass: Number(nodeVer.slice(1).split(".")[0]) >= 22, detail: nodeVer },
  { name: "npm", pass: !npmVer.startsWith("NOT"), detail: npmVer },
  { name: "opencode", pass: !opencodeVer.startsWith("NOT"), detail: opencodeVer },
  { name: "browser", pass: Boolean(browser.executablePath || browser.channel), detail: browser.executablePath ?? browser.channel ?? "none" },
  { name: "typescript", pass: !tscVer.startsWith("NOT"), detail: tscVer },
  { name: "vitest", pass: !vitestVer.startsWith("NOT"), detail: vitestVer },
  { name: "git", pass: !gitVer.startsWith("NOT"), detail: gitVer },
]

let allPass = true
for (const c of checks) {
  if (!c.pass) allPass = false
  console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`)
}

const proofPath = join(root, "proof/feasibility.json")
mkdirSync(join(root, "proof"), { recursive: true })
let proof = {}
try {
  proof = JSON.parse(readFileSync(proofPath, "utf8"))
} catch {}
proof.timestamp = new Date().toISOString()
proof.environment = {
  node: nodeVer,
  npm: npmVer,
  opencode: opencodeVer,
  git: gitVer,
  os: `${process.platform} ${process.arch}`,
  browser: browser.executablePath ?? browser.channel,
}
proof.gates = proof.gates ?? {}
proof.gates.G01 = {
  status: allPass ? "PASS" : "FAIL",
  evidence: checks.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
  command: "node scripts/g01-environment.mjs",
}
proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
writeFileSync(proofPath, JSON.stringify(proof, null, 2))
console.log(`\nG01 ${allPass ? "PASS" : "FAIL"}`)
process.exit(allPass ? 0 : 1)
