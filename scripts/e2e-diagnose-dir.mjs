#!/usr/bin/env node
/**
 * Diagnostic for G76-equivalent ("current directory is load-bearing"):
 * Run from inside a fixture; asks the model to report the exact runtime
 * directory. OpenCode's own answer is cross-checked against the bridge's
 * stored session record workspace and the process cwd.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const model = args[0] ?? "cgpt-project/chatgpt-project-web"

// find the latest session record for this workspace
const sessionsDir = process.env.CGPT_SESSION_DIR_OVERRIDE ?? join(process.env.HOME, "Library/Application Support/cgpt/sessions")
function recordsFor(dirPrefix) {
  if (!existsSync(sessionsDir)) return []
  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(sessionsDir, f), "utf8"))
      } catch {
        return null
      }
    })
    .filter((r) => r && r.workspaceDir?.startsWith(dirPrefix))
}

const prompt =
  "Use the shell tool to run exactly: pwd && basename \"$(pwd)\". Then answer with the absolute directory path you observed and nothing else."
console.log(JSON.stringify({ model, prompt: "pwd diagnostic" }))
const out = execSync(`opencode run --model ${model} ${JSON.stringify(prompt)}`, {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 600_000,
  env: process.env,
})
console.log("--- opencode output ---")
console.log(out)
const records = recordsFor(process.cwd().replace("/private/var", "/private/var"))
console.log("--- bridge session records for workspaces under cwd prefix ---")
for (const r of records) {
  console.log(JSON.stringify({ workspaceDir: r.workspaceDir, sessionId: r.sessionId, conversation: r.conversation?.id }))
}
