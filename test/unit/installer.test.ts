import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installOpenCodeConfig,
  uninstallOpenCodeConfig,
  installPlugin,
  uninstallPlugin,
  globalConfigDir,
  globalPluginDir,
  PROVIDER_ID,
  AGENT_ID,
  MODEL_ID,
} from "../../src/opencode/installer.js"

let root: string
let cfgDir: string
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
const prevStateDir = process.env.CGPT_STATE_DIR

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cgpt-installer-"))
  cfgDir = join(root, "opencode")
  mkdirSync(cfgDir, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = cfgDir
  process.env.CGPT_STATE_DIR = join(root, "state")
  mkdirSync(join(root, "state"), { recursive: true })
})

afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
  if (prevStateDir === undefined) delete process.env.CGPT_STATE_DIR
  else process.env.CGPT_STATE_DIR = prevStateDir
  rmSync(root, { recursive: true, force: true })
})

const reset = () => {
  rmSync(cfgDir, { recursive: true, force: true })
  mkdirSync(cfgDir, { recursive: true })
}

describe("opencode installer", () => {
  it("creates a new config when none exists", async () => {
    const report = await installOpenCodeConfig()
    expect(report.edited).toBe(true)
    const cfg = JSON.parse(readFileSync(join(cfgDir, "opencode.json"), "utf8"))
    expect(cfg.provider[PROVIDER_ID].options.baseURL).toContain(":3210")
    expect(cfg.provider[PROVIDER_ID].npm).toBe("@ai-sdk/openai-compatible")
    expect(cfg.agent[AGENT_ID].permission.external_directory).toBe("deny")
    expect(cfg.small_model).toBe(`${PROVIDER_ID}/${MODEL_ID}`)
  })

  it("is idempotent on plain JSON", async () => {
    const before = readFileSync(join(cfgDir, "opencode.json"), "utf8")
    const report = await installOpenCodeConfig()
    expect(report.edited).toBe(false)
    expect(readFileSync(join(cfgDir, "opencode.json"), "utf8")).toBe(before)
  })

  it("does not clobber unrelated providers/agents in plain JSON", async () => {
    reset()
    writeFileSync(
      join(cfgDir, "opencode.json"),
      JSON.stringify({
        provider: { openai: { options: { apiKey: "sk-user" } } },
        agent: { plan: { mode: "primary", permission: { edit: "deny" } } },
        small_model: "openai/gpt-4o-mini",
        theme: "dark",
      }),
      "utf8",
    )
    const report = await installOpenCodeConfig()
    expect(report.edited).toBe(true)
    const cfg = JSON.parse(readFileSync(join(cfgDir, "opencode.json"), "utf8"))
    expect(cfg.provider.openai.options.apiKey).toBe("sk-user")
    expect(cfg.agent.plan.permission.edit).toBe("deny")
    expect(cfg.theme).toBe("dark")
    expect(cfg.small_model).toBe("openai/gpt-4o-mini") // preserved
    expect(cfg.provider[PROVIDER_ID]).toBeDefined()
    expect(existsSync(`${join(cfgDir, "opencode.json")}.bak-cgpt-` + "*") || readdirSync(cfgDir).some((f) => f.includes(".bak-cgpt-"))).toBe(true)
  })

  it("JSONC global config: writes sibling opencode.json, leaves JSONC byte-identical", async () => {
    reset()
    const jsonc = `{\n  // my precious comment\n  "$schema": "https://opencode.ai/config.json",\n  "provider": {\n    "bank-of-ai": { "npm": "@ai-sdk/openai-compatible", "options": { "apiKey": "k" } }\n  },\n  "small_model": "openai/gpt-4o-mini"\n}\n`
    writeFileSync(join(cfgDir, "opencode.jsonc"), jsonc, "utf8")
    const before = readFileSync(join(cfgDir, "opencode.jsonc"), "utf8")
    const report = await installOpenCodeConfig()
    expect(report.edited).toBe(true)
    expect(readFileSync(join(cfgDir, "opencode.jsonc"), "utf8")).toBe(before)
    const sibling = JSON.parse(readFileSync(join(cfgDir, "opencode.json"), "utf8"))
    expect(sibling.provider[PROVIDER_ID]).toBeDefined()
    expect(sibling.agent[AGENT_ID]).toBeDefined()
    expect(sibling.small_model).toBe("openai/gpt-4o-mini") // preserved from jsonc
  })

  it("uninstall removes only integration-owned keys", async () => {
    // continuing from previous state: jsonc + sibling
    const report = await uninstallOpenCodeConfig()
    expect(report.edited).toBe(true)
    const sibling = JSON.parse(readFileSync(join(cfgDir, "opencode.json"), "utf8"))
    expect(sibling.provider).toBeUndefined()
    expect(sibling.agent).toBeUndefined()
    // user's small_model (preserved from jsonc) must survive uninstall
    expect(sibling.small_model).toBe("openai/gpt-4o-mini")
    // jsonc untouched
    const jsonc = readFileSync(join(cfgDir, "opencode.jsonc"), "utf8")
    expect(jsonc).toContain("bank-of-ai")
  })

  it("refuses to edit invalid JSON", async () => {
    reset()
    writeFileSync(join(cfgDir, "opencode.json"), "{ not valid json !!!", "utf8")
    const report = await installOpenCodeConfig()
    expect(report.edited).toBe(false)
    expect(report.snippet).toBeDefined()
    expect(readFileSync(join(cfgDir, "opencode.json"), "utf8")).toBe("{ not valid json !!!")
  })
})

describe("plugin installer", () => {
  it("installs and uninstalls the metadata plugin", async () => {
    const installed = await installPlugin()
    if ("conflict" in installed) throw new Error("plugin install failed")
    expect(readFileSync(installed.path, "utf8")).toContain("chat.headers")
    const un = await uninstallPlugin()
    expect(un.removed).toBeTruthy()
    expect(existsSync(globalPluginDir() + "/cgpt-bridge.js")).toBe(false)
  })

  it("refuses to overwrite a foreign plugin file", async () => {
    mkdirSync(globalPluginDir(), { recursive: true })
    writeFileSync(join(globalPluginDir(), "cgpt-bridge.js"), "// user's own file", "utf8")
    const res = await installPlugin()
    expect("conflict" in res).toBe(true)
    expect(readFileSync(join(globalPluginDir(), "cgpt-bridge.js"), "utf8")).toBe("// user's own file")
  })
})
