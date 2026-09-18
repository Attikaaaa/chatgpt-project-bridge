#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { serve } from "../daemon.js"
import { loadConfig, saveConfig, ConfigSchema } from "../state/config.js"
import {
  getBinding,
  removeBinding,
  setBinding,
  validateProjectUrlSyntax,
  canonicalWorkspace,
  loadRegistry,
} from "../state/workspaces.js"
import { loadSession, deleteSession, saveSession, sessionKey } from "../state/sessions.js"
import { loadToken, rotateToken } from "../security/auth.js"
import { log } from "../util/log.js"
import { CgptError, Codes } from "../util/errors.js"
import { PlaywrightChatBackend } from "../browser/playwright.js"
import { browserProfileDir, stateDir, tokenPath } from "../state/paths.js"
import {
  installOpenCodeConfig,
  installPlugin,
  uninstallOpenCodeConfig,
  uninstallPlugin,
  snippet,
  PROVIDER_ID,
  MODEL_ID,
  AGENT_ID,
} from "../opencode/installer.js"
import { RECOMMENDED_PROJECT_INSTRUCTIONS } from "../chatgpt/project-instructions.js"

const VERSION = "0.1.0"

function usage(): string {
  return `cgpt — ChatGPT Project bridge for OpenCode

Usage:
  cgpt login [--timeout-ms N]        Open a visible browser (dedicated profile) and log in to ChatGPT
  cgpt logout                        Open the profile browser to log out manually; clears local session state
  cgpt bind <project-url>            Bind the CURRENT directory to a ChatGPT Project (verified live)
  cgpt unbind                        Remove the binding for the current directory
  cgpt binding                       Show the binding for the current directory
  cgpt serve [--port N] [--host H] [--headless] [--unsafe-debug]   Start the local OpenAI-compatible bridge
  cgpt status                        Show daemon/binding/auth status
  cgpt doctor [--active]             Run environment + browser diagnostics (--active sends one harmless prompt)
  cgpt opencode install              Configure OpenCode (provider + agent + metadata plugin). Idempotent.
  cgpt opencode uninstall            Remove only integration-owned OpenCode configuration
  cgpt opencode config               Print the config snippet that install applies
  cgpt sessions                      List session mappings (paths truncated)
  cgpt session reset <sessionId>     Forget the ChatGPT conversation for an OpenCode session in this workspace
  cgpt browser-profile               Print the browser profile directory used by the bridge
  cgpt project-instructions          Print optional additive Project instructions (never required)
  cgpt config set <key> <value>      Set config (host, port, logLevel, browserExecutable, browserChannel)
  cgpt --version | --help
`
}

function fail(msg: string, code = 1): never {
  console.error("ERROR:", msg)
  process.exit(code)
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}

async function openBackendForCli(cfgAwait: ReturnType<typeof loadConfig>): Promise<PlaywrightChatBackend> {
  const cfg = await cfgAwait
  return new PlaywrightChatBackend({
    headless: cfg.headless,
    executablePath: cfg.browserExecutable,
    channel: cfg.browserChannel,
    navigationTimeoutMs: cfg.navigationTimeoutMs,
  })
}

async function cmdLogin(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const timeoutMs = Number(args["timeout-ms"] ?? 900000)
  const cfg = await loadConfig()

  // Phase 1: plain browser window (NO automation/CDP — Cloudflare treats it
  // as a normal browser). The user logs in and CLOSES the window; the
  // profile outlives the process.
  console.log("Megnyílik egy Brave ablak (dedikált cgpt profil).")
  console.log("Jelentkezz be a ChatGPT-be, majd ZÁRD BE az ablakot — a parancs folytatja magától.")
  const discovered = await (async () => {
    const { discoverBrowser } = await import("../browser/launch.js")
    return discoverBrowser({ browserExecutable: cfg.browserExecutable, browserChannel: cfg.browserChannel })
  })()
  const { browserProfileDir } = await import("../state/paths.js")
  const { ensureDir } = await import("../state/atomic-store.js")
  const profileDir = browserProfileDir()
  await ensureDir(profileDir)

  const phaseDeadline = Date.now() + timeoutMs
  void phaseDeadline
  // Simpler + portable: use `open` on macOS, direct spawn elsewhere.
  const url = "https://chatgpt.com/"
  if (process.platform === "darwin") {
    if (discovered.executablePath?.includes("Brave")) {
      spawn("open", ["-na", "Brave Browser", "--args", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", url], { stdio: "ignore", detached: true })
    } else if (discovered.executablePath) {
      spawn(discovered.executablePath, [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", url], { stdio: "ignore", detached: true })
    } else {
      spawn("open", [url], { stdio: "ignore", detached: true })
    }
  } else if (discovered.executablePath) {
    spawn(discovered.executablePath, [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", url], { stdio: "ignore", detached: true })
  } else {
    console.error("No browser executable found. Set cgpt config set browserExecutable <path>.")
    return 1
  }

  // Wait for the user to close the browser window (process exit) OR for the
  // deadline. Poll by watching for any process holding the profile.
  let windowClosed = false
  while (Date.now() < phaseDeadline) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const out = spawnSync("pgrep", ["-f", `user-data-dir=${profileDir}`], { encoding: "utf8" })
      if (out.status !== 0 || !out.stdout?.trim()) {
        windowClosed = true
        break
      }
    } catch {
      windowClosed = true
      break
    }
  }
  if (!windowClosed) {
    console.error("A bejelentkezési ablak nem zárult be a megadott időn belül.")
    return 1
  }
  await new Promise((r) => setTimeout(r, 2000)) // cookie flush

  // Phase 2: verify with Playwright, then prove persistence across restart.
  const backend = await openBackendForCli(Promise.resolve(cfg))
  try {
    const status = await backend.verifyAuth()
    if (!status.authenticated) {
      console.error(`A bejelentkezés nem ellenőrizhető: ${status.detail}`)
      return 1
    }
    console.log("Bejelentkezés észlelve. Ellenőrzöm, hogy újraindítás után is megmarad…")
    await backend.close()
    const backend2 = await openBackendForCli(Promise.resolve(cfg))
    const verify = await backend2.verifyAuth()
    await backend2.close()
    if (!verify.authenticated) {
      console.error(`A bejelentkezés nem maradt meg újraindítás után: ${verify.detail}`)
      return 1
    }
    console.log("Perzisztens bejelentkezés ellenőrizve.")
    return 0
  } finally {
    await backend.close().catch(() => {})
  }
}

async function cmdLogout(): Promise<number> {
  // Honest logout: the bridge cannot (and must not) manipulate ChatGPT
  // account state. Open the profile browser for the user to sign out.
  console.log("Logging out must be done inside the ChatGPT UI. Opening the profile browser…")
  const backend = await openBackendForCli(loadConfig())
  await backend.verifyAuth().catch(() => {})
  console.log("Sign out in the opened window, then close it.")
  console.log("Removing local session mappings…")
  await clearSessionState()
  await backend.close().catch(() => {})
  return 0
}

async function clearSessionState(): Promise<void> {
  const { sessionsDir } = await import("../state/paths.js")
  const { removeQuietly } = await import("../state/atomic-store.js")
  await removeQuietly(sessionsDir())
}

async function cmdBind(argv: string[]): Promise<number> {
  const url = argv[0]
  if (!url || url.startsWith("--")) {
    console.error(usage())
    return 2
  }
  const normalized = validateProjectUrlSyntax(url)
  const cwd = process.cwd()
  console.log(`Verifying project at ${normalized} with the authenticated browser profile…`)
  const backend = await openBackendForCli(loadConfig())
  try {
    const auth = await backend.verifyAuth()
    if (!auth.authenticated) {
      console.error(`ChatGPT browser profile is not authenticated.\n\nRun:\n  cgpt login`)
      return 1
    }
    const project = await backend.verifyProject(normalized)
    await backend.close()
    if (!project.ok) {
      console.error(`Configured ChatGPT Project could not be verified.\nNo binding was saved.\nDetail: ${project.detail}`)
      return 1
    }
    const entry = await setBinding(cwd, normalized, { projectId: project.projectId })
    console.log(`Bound:\n  ${await canonicalWorkspace(cwd)}\n  → ${entry.projectUrl} (project ${entry.projectId ?? "id-unknown"})`)
    return 0
  } finally {
    await backend.close().catch(() => {})
  }
}

async function cmdUnbind(): Promise<number> {
  const removed = await removeBinding(process.cwd())
  console.log(removed ? "Binding removed." : "No binding existed for this directory.")
  return 0
}

async function cmdBinding(): Promise<number> {
  const binding = await getBinding(process.cwd())
  if (!binding) {
    console.log("No ChatGPT Project is bound to the current directory.")
    return 1
  }
  console.log(JSON.stringify(binding, null, 2))
  return 0
}

async function cmdServe(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args["unsafe-debug"]) log.verboseBodies = true
  if (args["log-level"]) log.setLevel(String(args["log-level"]) as never)
  await serve({
    port: args.port ? Number(args.port) : undefined,
    host: args.host ? String(args.host) : undefined,
    headless: args.headless === true ? true : undefined,
    verboseBodies: args["unsafe-debug"] === true,
  })
  console.log(`Bridge ready on http://127.0.0.1:${args.port ?? 3210}/v1 (model: ${MODEL_ID}). Press Ctrl+C to stop.`)
  return new Promise((resolve) => {
    process.on("SIGINT", () => resolve(0))
    process.on("SIGTERM", () => resolve(0))
  })
}

async function cmdStatus(): Promise<number> {
  const cwd = await canonicalWorkspace(process.cwd())
  const binding = await getBinding(process.cwd())
  const token = await loadToken()
  let daemon = "not reachable"
  if (token) {
    try {
      const res = await fetch(`http://127.0.0.1:${(await loadConfig()).port}/health`)
      daemon = res.ok ? "reachable" : `unhealthy (HTTP ${res.status})`
    } catch {
      daemon = "not reachable"
    }
  }
  const out = {
    workspace: cwd,
    binding: binding ? { projectUrl: binding.entry.projectUrl, projectId: binding.entry.projectId } : null,
    stateDir: stateDir(),
    daemon,
    hasToken: token !== null,
  }
  console.log(JSON.stringify(out, null, 2))
  return binding ? 0 : 1
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const cfg = await loadConfig()
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  // Local checks
  const nodeMajor = Number(process.versions.node.split(".")[0])
  add("node", nodeMajor >= 22, `node ${process.versions.node}`)
  let opencodeVersion = "not found"
  try {
    opencodeVersion = await new Promise<string>((resolve) => {
      const p = spawn("opencode", ["--version"], { stdio: "pipe" })
      let out = ""
      p.stdout?.on("data", (d) => (out += d.toString()))
      p.on("error", () => resolve("not found"))
      p.on("close", () => resolve(out.trim() || "not found"))
    })
  } catch {
    /* keep default */
  }
  add("opencode", opencodeVersion !== "not found", opencodeVersion)
  const { discoverBrowser } = await import("../browser/launch.js")
  const browser = await discoverBrowser({ browserExecutable: cfg.browserExecutable, browserChannel: cfg.browserChannel })
  add("browser", Boolean(browser.executablePath || browser.channel), browser.executablePath ?? browser.channel ?? "none found")
  add("state-dir", true, stateDir())
  const token = await loadToken()
  add("auth-token", token !== null, token ? tokenPath() : "missing (run cgpt serve or cgpt opencode install)")
  const binding = await getBinding(process.cwd())
  add(
    "workspace-binding",
    binding !== null,
    binding ? `${binding.entry.projectUrl}` : `none for ${await canonicalWorkspace(process.cwd())} (run: cgpt bind <url>)`,
  )
  // Provider config presence
  let providerConfigured = false
  try {
    const ocCfg = await readFile(`${(await import("../opencode/installer.js")).globalConfigDir()}/opencode.json`, "utf8")
    providerConfigured = ocCfg.includes(`"${PROVIDER_ID}"`)
  } catch {
    /* absent */
  }
  add("opencode-provider", providerConfigured, providerConfigured ? `${PROVIDER_ID}/${MODEL_ID} in global config` : "missing (run: cgpt opencode install)")
  const pluginPath = `${(await import("../opencode/installer.js")).globalPluginDir()}/cgpt-bridge.js`
  let pluginPresent = false
  try {
    pluginPresent = (await readFile(pluginPath, "utf8")).includes("cgpt-project-bridge:owned")
  } catch {
    /* absent */
  }
  add("opencode-plugin", pluginPresent, pluginPresent ? pluginPath : `missing (${pluginPath})`)
  // Port availability / daemon
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/health`)
    add("daemon", res.ok, `http://127.0.0.1:${cfg.port}/health → ${res.ok}`)
  } catch {
    add("daemon", false, `not running on port ${cfg.port} (run: cgpt serve)`)
  }

  // Browser checks
  const backend = await openBackendForCli(loadConfig())
  try {
    const health = await backend.health()
    add("browser-launch", health.ok, health.detail)
    const auth = await backend.verifyAuth()
    add("chatgpt-authenticated", auth.authenticated, auth.detail)
    if (binding) {
      const project = await backend.verifyProject(binding.entry.projectUrl)
      add("project-reachable", project.ok, project.detail)
    }
    if (args.active === true) {
      if (!binding) {
        add("active-check", false, "requires a bound workspace")
      } else {
        console.log("Active check: submitting one harmless diagnostic prompt…")
        const marker = `DOCTOR_CHECK_${Date.now().toString(36)}`
        const started = await backend.startConversation(
          binding.entry.projectUrl,
          `Reply with exactly this JSON and nothing else: {"type":"final","content":"${marker}"}`,
          cfg.responseTimeoutMs,
        )
        const ok = started.result.text.includes(marker)
        add("active-check", ok, ok ? "exact response captured" : `unexpected response: ${started.result.text.slice(0, 80)}`)
      }
    }
  } catch (e) {
    add("browser-launch", false, (e as Error).message)
  } finally {
    await backend.close().catch(() => {})
  }

  console.log("\ncgpt doctor:")
  let failed = 0
  for (const c of checks) {
    if (!c.ok) failed++
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
  }
  if (!args.active) {
    console.log("\n(active ChatGPT submission check skipped; run `cgpt doctor --active` to include it)")
  }
  return failed === 0 ? 0 : 1
}

async function cmdSessions(): Promise<number> {
  const reg = await loadRegistry()
  const lines: Array<{ workspace: string; session: string; conversation: string | null; updatedAt: string }> = []
  for (const [dir] of Object.entries(reg)) {
    const { sessionsDir } = await import("../state/paths.js")
    const { readdir, readFile } = await import("node:fs/promises")
    let files: string[] = []
    try {
      files = await readdir(sessionsDir())
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      try {
        const rec = JSON.parse(await readFile(`${sessionsDir()}/${f}`, "utf8"))
        if (rec.workspaceDir === dir) {
          lines.push({
            workspace: dir,
            session: rec.sessionId,
            conversation: rec.conversation?.id ?? rec.conversation?.url ?? null,
            updatedAt: rec.updatedAt,
          })
        }
      } catch {
        /* skip corrupt */
      }
    }
  }
  if (lines.length === 0) {
    console.log("No session mappings.")
    return 0
  }
  for (const l of lines) console.log(JSON.stringify(l))
  return 0
}

async function cmdSessionReset(sessionId: string): Promise<number> {
  if (!sessionId) {
    console.error(usage())
    return 2
  }
  const binding = await getBinding(process.cwd())
  if (!binding) {
    console.error("No binding for the current directory; nothing to reset.")
    return 1
  }
  const key = sessionKey(binding.dir, sessionId)
  const rec = await loadSession(key)
  if (!rec) {
    console.log("No stored mapping for that session in this workspace.")
    return 0
  }
  await deleteSession(key)
  console.log(`Session mapping removed. Next request for ${sessionId} will start a new ChatGPT conversation.`)
  return 0
}

async function cmdOpencodeInstall(): Promise<number> {
  const cfg = await loadConfig()
  const report = await installOpenCodeConfig({ port: cfg.port })
  const plugin = await installPlugin()
  if ("conflict" in plugin) {
    console.error(`A file already exists at ${plugin.conflict} without the bridge marker; not overwriting.`)
    return 1
  }
  console.log(`Plugin installed: ${plugin.path}`)
  if (report.edited) console.log(`Config updated: ${report.configPath}${report.backupPath ? ` (backup: ${report.backupPath})` : ""}`)
  for (const n of report.notes) console.log(`  - ${n}`)
  if (report.snippet) {
    console.log("Add this to your OpenCode config manually:\n" + report.snippet)
  }
  const token = await loadToken()
  if (!token) {
    await rotateToken()
    console.log("Generated a new local auth token (stored with 0600 permissions).")
  }
  console.log(`\nNext: start the bridge with 'cgpt serve', then run 'opencode' and pick ${PROVIDER_ID}/${MODEL_ID} (or the '${AGENT_ID}' agent).`)
  return 0
}

async function cmdOpencodeUninstall(): Promise<number> {
  const report = await uninstallOpenCodeConfig()
  const plugin = await uninstallPlugin()
  if (plugin.conflict) {
    console.error(`Plugin at ${plugin.conflict} is not bridge-owned; leaving it alone.`)
    return 1
  }
  console.log(plugin.removed ? `Plugin removed: ${plugin.removed}` : "No bridge plugin found.")
  for (const n of report.notes) console.log(`  - ${n}`)
  if (report.edited && report.backupPath) console.log(`Backup: ${report.backupPath}`)
  return 0
}

async function cmdOpencodeConfig(): Promise<number> {
  const token = (await loadToken()) ?? "<run cgpt serve to generate>"
  const cfg = await loadConfig()
  console.log(snippet(PROVIDER_ID, cfg.port, token))
  return 0
}

async function cmdConfigSet(key: string, value: string): Promise<number> {
  const cfg = await loadConfig()
  const parsed = ConfigSchema.safeParse({ ...cfg, [key]: key === "port" ? Number(value) : key === "headless" ? value === "true" : value })
  if (!parsed.success) {
    console.error(`Invalid config key or value: ${key}=${value}\nValid keys: ${Object.keys(ConfigSchema.shape).join(", ")}`)
    return 2
  }
  await saveConfig(parsed.data)
  console.log(`Config saved: ${key}=${value}`)
  return 0
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd || cmd === "--help" || cmd === "help" || cmd === "-h") {
    console.log(usage())
    return cmd ? 0 : 0
  }
  if (cmd === "--version" || cmd === "version") {
    console.log(VERSION)
    return 0
  }
  try {
    switch (cmd) {
      case "login":
        return await cmdLogin(argv.slice(1))
      case "logout":
        return await cmdLogout()
      case "bind":
        return await cmdBind(argv.slice(1))
      case "unbind":
        return await cmdUnbind()
      case "binding":
        return await cmdBinding()
      case "serve":
        return await cmdServe(argv.slice(1))
      case "status":
        return await cmdStatus()
      case "doctor":
        return await cmdDoctor(argv.slice(1))
      case "sessions":
        return await cmdSessions()
      case "session": {
        const sub = argv[1]
        if (sub === "reset") return await cmdSessionReset(argv[2] ?? "")
        console.error(usage())
        return 2
      }
      case "opencode": {
        const sub = argv[1]
        if (sub === "install") return await cmdOpencodeInstall()
        if (sub === "uninstall") return await cmdOpencodeUninstall()
        if (sub === "config") return await cmdOpencodeConfig()
        console.error(usage())
        return 2
      }
      case "config": {
        const sub = argv[1]
        if (sub === "set") return await cmdConfigSet(argv[2] ?? "", argv[3] ?? "")
        console.log(JSON.stringify(await loadConfig(), null, 2))
        return 0
      }
      case "browser-profile":
        console.log(browserProfileDir())
        return 0
      case "project-instructions":
        console.log(RECOMMENDED_PROJECT_INSTRUCTIONS)
        return 0
      default:
        console.error(usage())
        return 2
    }
  } catch (err) {
    if (err instanceof CgptError) {
      console.error(`ERROR [${err.code}]: ${err.message}`)
      return 1
    }
    console.error("ERROR:", (err as Error).message ?? err)
    return 1
  }
}

main().then((code) => process.exit(code))
