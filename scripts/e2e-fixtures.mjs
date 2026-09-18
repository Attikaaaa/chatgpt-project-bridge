#!/usr/bin/env node
/**
 * Fixture factory for the real-OpenCode E2E gates.
 * Creates fixture-a and fixture-b under the repo's ignored test/fixtures
 * area, each with unique random canaries and (for fixture-a) a failing test.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const base = join(root, "test/fixtures/e2e-workspaces")
rmSync(base, { recursive: true, force: true })
mkdirSync(join(base, "fixture-a/src"), { recursive: true })
mkdirSync(join(base, "fixture-b/src"), { recursive: true })

const canaryA = `CANARY_A_${randomUUID().slice(0, 8)}`
const canaryB = `CANARY_B_${randomUUID().slice(0, 8)}`

// fixture-a: README with canary + a tiny calculator with a bug + failing test
writeFileSync(
  join(base, "fixture-a/README.md"),
  `# fixture-a\n\nProject canary: ${canaryA}\n`,
)
writeFileSync(
  join(base, "fixture-a/src/add.js"),
  `function add(a, b) {\n  return a - b // BUG: should be a + b\n}\n\nmodule.exports = { add }\n`,
)
writeFileSync(
  join(base, "fixture-a/src/add.test.js"),
  `const { add } = require('./add')\n\nif (add(2, 3) !== 5) {\n  console.error('FAIL: add(2,3) returned', add(2, 3))\n  process.exit(1)\n}\nconsole.log('PASS')\n`,
)
writeFileSync(join(base, "fixture-a/package.json"), JSON.stringify({ name: "fixture-a", private: true }, null, 2))

// fixture-b: README with its own canary
writeFileSync(
  join(base, "fixture-b/README.md"),
  `# fixture-b\n\nProject canary: ${canaryB}\n`,
)
writeFileSync(join(base, "fixture-b/package.json"), JSON.stringify({ name: "fixture-b", private: true }, null, 2))

// git init both so "git diff contains only expected changes" is checkable
const { execSync } = await import("node:child_process")
for (const f of ["fixture-a", "fixture-b"]) {
  execSync("git init -q", { cwd: join(base, f) })
  execSync('git -c user.email=fixture@local -c user.name=fixture add -A', { cwd: join(base, f) })
  execSync('git -c user.email=fixture@local -c user.name=fixture commit -qm "fixture"', { cwd: join(base, f) })
}

console.log(JSON.stringify({ base, canaryA, canaryB }, null, 2))
