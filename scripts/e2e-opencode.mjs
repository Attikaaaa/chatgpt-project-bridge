#!/usr/bin/env node
/**
 * G09–G13, G18 (OpenCode-side halves) — REAL OpenCode CLI against the REAL
 * bridge daemon over HTTP; the ChatGPT side is a deterministic scripted
 * backend (the real-ChatGPT halves are covered by G08-real-browser and,
 * after `cgpt login`, the project-bound gates).
 *
 * Proves, end to end with the real opencode binary, real plugin header
 * injection, real tool execution:
 *   G09  read canary via OpenCode's own file tools
 *   G10  bug fix + test run driven by tool calls; git diff limited
 *   G11  workspace isolation (fixture-a touched, fixture-b byte-identical)
 *   G12  two sessions → two separate conversations
 *   G13  two workspaces → two different project bindings
 *   G18  external-directory edit denied by the cgpt-build agent
 */
import { spawn, execSync } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync, readdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const port = 13211
const token = "e2e-local-token"
const fixturesBase = join(root, "test/fixtures/e2e-workspaces")

// --- build fixtures
execSync("node scripts/e2e-fixtures.mjs", { cwd: root, stdio: "pipe" })
const canaryA = readFileSync(join(fixturesBase, "fixture-a/README.md"), "utf8").match(/CANARY_A_[0-9a-f-]+/)[0]
const canaryB = readFileSync(join(fixturesBase, "fixture-b/README.md"), "utf8").match(/CANARY_B_[0-9a-f-]+/)[0]

const fixtureA = join(fixturesBase, "fixture-a")
const fixtureB = join(fixturesBase, "fixture-b")
const hashB = () =>
  execSync(`find "${fixtureB}" -type f -not -path "*/.git/*" -exec shasum {} + | shasum`).toString().trim()
const hashBBefore = hashB()

// --- isolated OpenCode config dir (provider on the test port + plugin)
const ocDir = mkdtempSync(join(tmpdir(), "oc-e2e-"))
mkdirSync(join(ocDir, "plugins"), { recursive: true })
const pluginSrc = readFileSync(join(root, "src/opencode/plugin-template.ts"), "utf8")
const pluginBody = pluginSrc.replace(/^.*?PLUGIN_TEMPLATE = `/s, "").replace(/`\s*$/s, "")
writeFileSync(join(ocDir, "plugins", "cgpt-bridge.js"), pluginBody)
writeFileSync(
  join(ocDir, "opencode.json"),
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      "cgpt-project": {
        npm: "@ai-sdk/openai-compatible",
        name: "ChatGPT Project Web",
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: token },
        models: {
          "chatgpt-project-web": { name: "chatgpt-project-web", limit: { context: 128000, output: 16384 } },
        },
      },
    },
    small_model: "cgpt-project/chatgpt-project-web",
    agent: {
      "cgpt-build": {
        mode: "primary",
        description: "safe agent",
        model: "cgpt-project/chatgpt-project-web",
        permission: {
          edit: "allow",
          bash: { "*": "ask", "git push*": "deny", "rm *": "deny", "node *": "allow" },
          webfetch: "ask",
          external_directory: "deny",
        },
      },
    },
  }),
)

// --- fake ChatGPT backend script. Steps match on message CONTENT (tool_call
// ids), so small-model title-generation requests (which carry no tool
// results) fall through to the default catch-all and never corrupt the flow.
const script = [
  { match: ["CURRENT TOOL MANIFEST"], respond: `{"type":"tool_calls","calls":[{"id":"call_1","name":"read","arguments":{"filePath":"${fixtureA}/README.md"}}]}` },
  { match: "call_id=call_1", echoFrom: "CANARY_A_[0-9a-f-]+" },
  { match: ["CURRENT TOOL MANIFEST", "add.js"], respond: `{"type":"tool_calls","calls":[{"id":"call_2","name":"read","arguments":{"filePath":"${fixtureA}/src/add.js"}}]}` },
  { match: "call_id=call_2", respond: `{"type":"tool_calls","calls":[{"id":"call_3","name":"read","arguments":{"filePath":"${fixtureA}/src/add.test.js"}}]}` },
  { match: "call_id=call_3", respond: '{"type":"tool_calls","calls":[{"id":"call_4","name":"apply_patch","arguments":{"patchText":"*** Begin Patch\\n*** Update File: src/add.js\\n@@\\n-  return a - b // BUG: should be a + b\\n+  return a + b\\n*** End Patch"}}]}' },
  { match: "call_id=call_4", respond: '{"type":"tool_calls","calls":[{"id":"call_5","name":"bash","arguments":{"command":"node src/add.test.js"}}]}' },
  { match: "call_id=call_5", echoFrom: "PASS|FAIL" },
  // G18: the model asks for the external file; agent-level permission denies it
  { match: ["CURRENT TOOL MANIFEST", "fixture-b"], respond: `{"type":"tool_calls","calls":[{"id":"call_9","name":"read","arguments":{"filePath":"${fixtureB}/README.md"}}]}` },
  { match: "call_id=call_9", respond: '{"type":"final","content":"I was not able to read that file."}' },
  { respond: '{"type":"final","content":"ok"}' },
]
const scriptPath = join(fixturesBase, "g10-script.json")
writeFileSync(scriptPath, JSON.stringify(script))

// --- start daemon with BOTH workspaces bound to different fake projects
const daemon = spawn("node", [join(root, "scripts/fake-daemon.mjs"), String(port), token, fixtureA, scriptPath], {
  env: { ...process.env, CGPT_BINDINGS: `${fixtureB}=https://chatgpt.com/fake/g-p-projB` },
  stdio: ["ignore", "pipe", "pipe"],
})
let daemonStateDir = null
let ready = false
const daemonOut = []
daemon.stdout.on("data", (d) => {
  daemonOut.push(String(d))
  const line = String(d)
  if (line.includes('"ready"')) {
    try {
      daemonStateDir = JSON.parse(line).stateDir
    } catch {}
    ready = true
  }
})
daemon.stderr.on("data", (d) => daemonOut.push("[stderr] " + String(d)))
for (let i = 0; i < 100 && !ready; i++) await new Promise((r) => setTimeout(r, 100))
if (!ready) {
  console.error("daemon failed to start:\n" + daemonOut.join("").slice(0, 3000))
  process.exit(1)
}

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

function opencodeRun(cwd, prompt, extraArgs = []) {
  try {
    return execSync(
      `opencode run --model cgpt-project/chatgpt-project-web ${extraArgs.join(" ")} ${JSON.stringify(prompt)}`,
      {
        cwd,
        encoding: "utf8",
        timeout: 300_000,
        env: { ...process.env, OPENCODE_CONFIG_DIR: ocDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
  } catch (e) {
    const err = e
    const out = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join("\n[stderr] ")
    throw new Error(`opencode run failed: ${out.slice(0, 2000)}`)
  }
}

function sessionRecords() {
  return readdirSync(join(daemonStateDir, "sessions"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(daemonStateDir, "sessions", f), "utf8")))
}

try {
  // ---- G09: read canary from fixture-a using OpenCode's own read tool
  const g09 = opencodeRun(fixtureA, "Use the read tool to read README.md, then tell me the exact project canary value in it.")
  record("G09-read-canary", g09.includes(canaryA), `canary=${canaryA} found=${g09.includes(canaryA)}`)
  if (process.env.E2E_DEBUG) {
    for (const f of readdirSync(join(daemonStateDir, "sessions")).filter((f) => f.endsWith(".json"))) {
      const rec = JSON.parse(readFileSync(join(daemonStateDir, "sessions", f), "utf8"))
      const convId = rec.conversation?.url?.match(/c\/([^/?]+)/)?.[1]
      console.log("SESSION", rec.sessionId, "ws=", rec.workspaceDir.split("/").pop(), "conv=", convId)
    }
  }

  // ---- G10: bug fix + test
  const g10 = opencodeRun(
    fixtureA,
    "The test in src/add.test.js fails. Read src/add.js and src/add.test.js, then fix add.js with the smallest correct change using apply_patch, then run the focused test with bash: node src/add.test.js. Report the test output.",
  )
  const addJs = readFileSync(join(fixtureA, "src/add.js"), "utf8")
  const fixed = addJs.includes("return a + b")
  const diff = execSync("git diff --stat", { cwd: fixtureA, encoding: "utf8" })
  const diffOnlyAdd = /src\/add\.js/.test(diff) && !/add\.test\.js/.test(diff) && !/README\.md/.test(diff)
  record("G10-source-actually-changed", fixed, `add.js contains fix=${fixed}`)
  record("G10-test-output-seen-by-model", /PASS/.test(g10), `output mentions PASS=${/PASS/.test(g10)}`)
  record("G10-git-diff-limited", diffOnlyAdd, `diff stat: ${diff.replace(/\n/g, " | ").trim()}`)

  // ---- G11: fixture-b unchanged
  record("G11-fixture-b-unchanged", hashB() === hashBBefore, `hash match=${hashB() === hashBBefore}`)

  // ---- G12: two runs in fixture-a → two OpenCode sessions → two conversations
  opencodeRun(fixtureA, "What is 2+2? Answer with just the number.")
  opencodeRun(fixtureA, "What is 3+3? Answer with just the number.")
  const recsA = sessionRecords().filter((r) => r.workspaceDir === resolve(fixtureA))
  const distinctConvos = new Set(recsA.map((r) => r.conversation?.url))
  record(
    "G12-sessions-separate-conversations",
    recsA.length >= 3 && distinctConvos.size === recsA.length,
    `records=${recsA.length} distinctConversations=${distinctConvos.size}`,
  )

  // ---- G13: two workspaces → different project bindings
  const recsB = sessionRecords().filter((r) => r.workspaceDir === resolve(fixtureB))
  // fixture-b has no session yet; run one
  opencodeRun(fixtureB, "What is 1+1? Answer with just the number.")
  const recsB2 = sessionRecords().filter((r) => r.workspaceDir === resolve(fixtureB))
  const projectUrlsA = new Set(recsA.map((r) => r.projectUrl))
  const projectUrlsB = new Set(recsB2.map((r) => r.projectUrl))
  record(
    "G13-workspaces-route-to-distinct-projects",
    projectUrlsA.size === 1 && projectUrlsB.size === 1 && ![...projectUrlsA].some((u) => projectUrlsB.has(u)),
    `A=${[...projectUrlsA].join(",")} B=${[...projectUrlsB].join(",")}`,
  )

  // ---- G18: external directory denial via cgpt-build agent
  const g18 = opencodeRun(
    fixtureA,
    `Use the read tool to read the file ${fixtureB}/README.md and tell me the canary in it.`,
    ["--agent", "cgpt-build"],
  )
  record("G18-external-read-denied", !g18.includes(canaryB), `fixture-b canary leaked=${g18.includes(canaryB)}`)
  record("G18-fixture-b-still-unchanged", hashB() === hashBBefore, `hash match=${hashB() === hashBBefore}`)
} catch (e) {
  record("harness", false, String(e.message).slice(0, 400))
} finally {
  daemon.kill("SIGTERM")
}

const allPass = results.every((r) => r.pass)
// record proof
const { mkdirSync: mk } = await import("node:fs")
const proofPath = join(root, "proof/feasibility.json")
let proof = {}
try {
  proof = JSON.parse(readFileSync(proofPath, "utf8"))
} catch {}
proof.timestamp = new Date().toISOString()
proof.gates = proof.gates ?? {}
const byName = Object.fromEntries(results.map((r) => [r.name, r]))
const gate = (id, names, note) => {
  proof.gates[id] = {
    status: names.every((n) => byName[n]?.pass) ? "PASS" : "FAIL",
    note,
    evidence: names.map((n) => `${byName[n]?.pass ? "PASS" : "FAIL"} ${n}: ${byName[n]?.detail}`),
    command: "node scripts/e2e-opencode.mjs",
  }
}
gate("G09_OPENCODE_SIDE", ["G09-read-canary"], "Real OpenCode + real bridge daemon; ChatGPT side scripted (real-model protocol proof: G08_REAL_BROWSER)")
gate("G10_OPENCODE_SIDE", ["G10-source-actually-changed", "G10-test-output-seen-by-model", "G10-git-diff-limited"], "OpenCode applied the patch, ran the test, model saw PASS, diff limited")
gate("G11_OPENCODE_SIDE", ["G11-fixture-b-unchanged"], "fixture-b byte-identical during fixture-a runs")
gate("G12_OPENCODE_SIDE", ["G12-sessions-separate-conversations"], "Each OpenCode session mapped to its own conversation")
gate("G13_OPENCODE_SIDE", ["G13-workspaces-route-to-distinct-projects"], "fixture-a/b bound to different projects; routing by runtime dir")
gate("G18", ["G18-external-read-denied", "G18-fixture-b-still-unchanged"], "cgpt-build agent external_directory=deny enforced by OpenCode (not the bridge)")
proof.overall = Object.values(proof.gates).every((g) => g.status === "PASS") ? "PASS" : "INCOMPLETE"
writeFileSync(proofPath, JSON.stringify(proof, null, 2))
console.log(`\nE2E(OpenCode-side) ${allPass ? "PASS" : "FAIL"}`)
process.exit(allPass ? 0 : 1)
