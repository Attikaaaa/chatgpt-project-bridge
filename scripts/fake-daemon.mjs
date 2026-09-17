#!/usr/bin/env node
/**
 * Standalone daemon with a FAKE ChatGPT backend for deterministic G07 tests.
 * Not part of the product surface; used by scripts/g07-raw-provider.mjs.
 *
 * Usage: node scripts/fake-daemon.mjs <port> <token> <workspace-dir> <script-json>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildServer } from "../dist/server/http.js"
import { TurnService } from "../dist/server/turn-service.js"
import { FakeChatBackend } from "../dist/browser/fake.js"
import { setBinding } from "../dist/state/workspaces.js"
import { rotateToken } from "../dist/security/auth.js"

const [portArg, tokenArg, workspaceArg, scriptArg] = process.argv.slice(2)
const port = Number(portArg ?? 3210)
const token = tokenArg ?? (await rotateToken())
const workspace = resolve(workspaceArg ?? process.cwd())
const script = scriptArg ? JSON.parse(readFileSync(scriptArg, "utf8")) : []

const stateDir = mkdtempSync(join(tmpdir(), "cgpt-fake-daemon-"))
process.env.CGPT_STATE_DIR = stateDir
mkdirSync(workspace, { recursive: true })
await setBinding(workspace, "https://chatgpt.com/fake/g-p-gate07")

const backend = new FakeChatBackend(script)
const turns = new TurnService(backend)
const app = await buildServer(turns, { host: "127.0.0.1", port, token })
await app.listen({ port, host: "127.0.0.1" })
writeFileSync(join(stateDir, "daemon.json"), JSON.stringify({ port, workspace }))

console.log(JSON.stringify({ ready: true, port, workspace, stateDir }))
process.on("SIGTERM", async () => {
  await app.close()
  process.exit(0)
})
