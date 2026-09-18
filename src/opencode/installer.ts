import { homedir } from "node:os"
import { join } from "node:path"
import { access, chmod, constants, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { PLUGIN_MARKER, PLUGIN_TEMPLATE } from "./plugin-template.js"
import { atomicWriteText } from "../state/atomic-store.js"
import { loadToken } from "../security/auth.js"
import { log } from "../util/log.js"

export const PROVIDER_ID = "cgpt-project"
export const MODEL_ID = "chatgpt-project-web"
export const AGENT_ID = "cgpt-build"
export const DEFAULT_PORT = 3210

export interface InstallReport {
  configPath: string | null
  backupPath: string | null
  pluginPath?: string | null
  edited: boolean
  notes: string[]
  snippet?: string
}

export function globalConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  return join(homedir(), ".config", "opencode")
}

export function globalPluginDir(): string {
  return join(globalConfigDir(), "plugins")
}

async function findGlobalConfig(): Promise<string | null> {
  if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = join(globalConfigDir(), name)
    if (await exists(p)) return p
  }
  return null
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function providerBlock(token: string, port: number): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "ChatGPT Project Web",
    options: {
      baseURL: `http://127.0.0.1:${port}/v1`,
      // NOTE: {file:...} substitution is NOT applied by opencode 1.18.31 to
      // provider apiKey options (verified empirically), so the token is
      // inlined; the config file is chmod 0600 after install.
      apiKey: token,
    },
    models: {
      [MODEL_ID]: {
        name: "chatgpt-project-web",
        // Transport budget for the bridge (documented in README). Not a
        // claim about any underlying ChatGPT model.
        limit: { context: 128000, output: 16384 },
      },
    },
  }
}

export function agentBlock(model = `${PROVIDER_ID}/${MODEL_ID}`): Record<string, unknown> {
  return {
    mode: "primary",
    description: "OpenCode agent backed by the local ChatGPT Project bridge (safe defaults)",
    model,
    permission: {
      edit: "allow",
      bash: {
        "*": "ask",
        "git push*": "deny",
        "git push --force*": "deny",
        "rm *": "deny",
        "npm test*": "allow",
        "npm run test*": "allow",
      },
      webfetch: "ask",
      external_directory: "deny",
    },
  }
}

export function snippet(providerId = PROVIDER_ID, port = DEFAULT_PORT, tokenRef = "<your-bridge-token>"): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      small_model: `${providerId}/${MODEL_ID}`,
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "ChatGPT Project Web",
          options: {
            baseURL: `http://127.0.0.1:${port}/v1`,
            apiKey: tokenRef,
          },
          models: {
            [MODEL_ID]: { name: "chatgpt-project-web", limit: { context: 128000, output: 16384 } },
          },
        },
      },
      agent: {
        [AGENT_ID]: agentBlock(),
      },
    },
    null,
    2,
  )
}

export async function installPlugin(): Promise<{ path: string; overwritten: boolean } | { conflict: string }> {
  const dir = globalPluginDir()
  await mkdir(dir, { recursive: true })
  const pluginPath = join(dir, "cgpt-bridge.js")
  if (await exists(pluginPath)) {
    const current = await readFile(pluginPath, "utf8")
    if (!current.includes(PLUGIN_MARKER)) {
      return { conflict: pluginPath }
    }
  }
  await atomicWriteText(pluginPath, PLUGIN_TEMPLATE, 0o644)
  return { path: pluginPath, overwritten: true }
}

export async function uninstallPlugin(): Promise<{ removed: string | null; conflict: string | null }> {
  const pluginPath = join(globalPluginDir(), "cgpt-bridge.js")
  if (!(await exists(pluginPath))) return { removed: null, conflict: null }
  const current = await readFile(pluginPath, "utf8")
  if (!current.includes(PLUGIN_MARKER)) return { removed: null, conflict: pluginPath }
  await (await import("node:fs/promises")).rm(pluginPath, { force: true })
  return { removed: pluginPath, conflict: null }
}

/**
 * Merge integration-owned keys into the global OpenCode config.
 * Idempotent. Never touches unrelated keys. Creates a timestamped backup
 * before writing.
 *
 * JSONC handling: if the only global config is a JSONC file (comments),
 * this does NOT edit that file. OpenCode merges every config file in the
 * config directory (verified empirically against opencode 1.18.31), so a
 * sibling opencode.json containing only integration-owned keys is created
 * instead. The user's JSONC file is left byte-identical.
 */
export async function installOpenCodeConfig(opts: { port?: number } = {}): Promise<InstallReport> {
  const notes: string[] = []
  const cfgPath = await findGlobalConfig()
  const port = opts.port ?? DEFAULT_PORT
  const token = (await loadToken()) ?? "RUN-cgpt-serve-to-generate"

  if (!cfgPath) {
    await mkdir(globalConfigDir(), { recursive: true })
    const created = join(globalConfigDir(), "opencode.json")
    const backupPath = null
    const merged = buildMergedConfig({}, port, token, notes)
    await atomicWriteText(created, JSON.stringify(merged, null, 2) + "\n", 0o644)
    await chmod(created, 0o600).catch(() => {})
    notes.push("created new global opencode config (permissions 0600)")
    return finalize({ configPath: created, backupPath, edited: true, notes })
  }

  // If the found config is the JSONC file, write a sibling JSON instead of
  // touching comments. (Merge behavior verified against opencode 1.18.31.)
  if (cfgPath.endsWith(".jsonc")) {
    const sibling = join(globalConfigDir(), "opencode.json")
    if (await exists(sibling)) {
      // Sibling already exists — it is JSON, edit that one.
      return editJsonConfig(sibling, port, token, notes)
    }
    const existingJsonc = safeJsonParse(stripJsoncComments(await readFile(cfgPath, "utf8")))
    let preserveSmallModel: unknown = undefined
    if (existingJsonc.ok) {
      const jsoncValue = existingJsonc.value as Record<string, unknown>
      if (jsoncValue.small_model !== undefined && jsoncValue.small_model !== `${PROVIDER_ID}/${MODEL_ID}`) {
        preserveSmallModel = jsoncValue.small_model
        notes.push(`existing small_model (${String(preserveSmallModel)}) left untouched`)
      }
    }
    const merged = buildMergedConfig({}, port, token, notes, preserveSmallModel !== undefined)
    if (preserveSmallModel !== undefined) merged.small_model = preserveSmallModel
    await atomicWriteText(sibling, JSON.stringify(merged, null, 2) + "\n", 0o644)
    await chmod(sibling, 0o600).catch(() => {})
    notes.push("sibling config file permissions set to 0600 (contains the local bridge token)")
    notes.push(`global config is JSONC (${cfgPath}); integration keys written to sibling ${sibling} (JSONC untouched)`)
    return finalize({ configPath: sibling, backupPath: null, edited: true, notes })
  }

  return editJsonConfig(cfgPath, port, token, notes)
}

function stripJsoncComments(raw: string): string {
  // Conservative line/block comment stripper for small_model detection only.
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
}

function editJsonConfig(cfgPath: string, port: number, token: string, notes: string[]): Promise<InstallReport> {
  return (async () => {
    const raw = await readFile(cfgPath, "utf8")
    const strictParse = safeJsonParse(raw)
    if (!strictParse.ok) {
      notes.push("config is not valid JSON; NOT editing automatically")
      return finalize({
        configPath: cfgPath,
        backupPath: null,
        edited: false,
        notes,
        snippet: snippet(PROVIDER_ID, port, token),
      })
    }

    const before = JSON.stringify(strictParse.value)
    const merged = buildMergedConfig(strictParse.value as Record<string, unknown>, port, token, notes)
    if (JSON.stringify(merged) === before) {
      notes.push("config already up to date (idempotent)")
      return finalize({ configPath: cfgPath, backupPath: null, edited: false, notes })
    }

    const backupPath = `${cfgPath}.bak-cgpt-${Date.now()}`
    await copyFile(cfgPath, backupPath)
    await atomicWriteText(cfgPath, JSON.stringify(merged, null, 2) + "\n", 0o644)
    await chmod(cfgPath, 0o600).catch(() => {})
    notes.push("config file permissions set to 0600 (contains the local bridge token)")
    return finalize({ configPath: cfgPath, backupPath, edited: true, notes })
  })()
}

function buildMergedConfig(
  existing: Record<string, unknown>,
  port: number,
  token: string,
  notes: string[],
  skipSmallModelNote = false,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  const providers = (merged.provider as Record<string, unknown> | undefined) ?? {}
  merged.provider = {
    ...providers,
    [PROVIDER_ID]: providerBlock(token, port),
  }
  const agents = (merged.agent as Record<string, unknown> | undefined) ?? {}
  merged.agent = {
    ...agents,
    [AGENT_ID]: agentBlock(),
  }
  // Zero-friction default: make the built-in "build" agent use the bridge
  // model UNLESS the user already configured their own "build" agent.
  if (!("build" in agents)) {
    merged.agent = {
      ...merged.agent as Record<string, unknown>,
      build: {
        mode: "primary",
        model: `${PROVIDER_ID}/${MODEL_ID}`,
      },
    }
    notes.push("built-in 'build' agent defaulted to the bridge model (override by defining agent.build yourself)")
  }
  if (merged.small_model === undefined) {
    merged.small_model = `${PROVIDER_ID}/${MODEL_ID}`
    if (!skipSmallModelNote) {
      notes.push("small_model set to the bridge model (session titles route through the bridge)")
    }
  } else if (merged.small_model !== `${PROVIDER_ID}/${MODEL_ID}`) {
    notes.push(`existing small_model (${String(merged.small_model)}) left untouched`)
  }
  return merged
}

function safeJsonParse(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

export async function uninstallOpenCodeConfig(): Promise<InstallReport> {
  const notes: string[] = []
  const cfgPath = await findGlobalConfig()
  if (!cfgPath) {
    notes.push("no global opencode config found")
    return finalize({ configPath: null, backupPath: null, edited: false, notes })
  }
  const raw = await readFile(cfgPath, "utf8")
  const parsed = safeJsonParse(raw)
  if (!parsed.ok) {
    notes.push("config is not valid JSON; refusing to edit")
    return finalize({ configPath: cfgPath, backupPath: null, edited: false, notes })
  }
  const cfg = parsed.value as Record<string, unknown>
  const before = JSON.stringify(cfg)

  const providers = cfg.provider as Record<string, unknown> | undefined
  if (providers && PROVIDER_ID in providers) {
    const { [PROVIDER_ID]: _removed, ...rest } = providers
    if (Object.keys(rest).length === 0) delete cfg.provider
    else cfg.provider = rest
    notes.push(`removed provider.${PROVIDER_ID}`)
  }
  const agents = cfg.agent as Record<string, unknown> | undefined
  if (agents && AGENT_ID in agents) {
    const { [AGENT_ID]: _removed, ...rest } = agents
    if (Object.keys(rest).length === 0) delete cfg.agent
    else cfg.agent = rest
    notes.push(`removed agent.${AGENT_ID}`)
  }
  if (cfg.small_model === `${PROVIDER_ID}/${MODEL_ID}`) {
    delete cfg.small_model
    notes.push("removed small_model (was the bridge model)")
  }

  if (JSON.stringify(cfg) === before) {
    notes.push("nothing integration-owned found in config (idempotent)")
    return finalize({ configPath: cfgPath, backupPath: null, edited: false, notes })
  }
  const backupPath = `${cfgPath}.bak-cgpt-${Date.now()}`
  await copyFile(cfgPath, backupPath)
  await atomicWriteText(cfgPath, JSON.stringify(cfg, null, 2) + "\n", 0o644)
  return finalize({ configPath: cfgPath, backupPath, edited: true, notes })
}

function finalize(r: InstallReport): InstallReport {
  for (const n of r.notes) log.info(n)
  return r
}
