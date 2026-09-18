import { z } from "zod"
import { configPath } from "./paths.js"
import { atomicWriteJson, readJson } from "./atomic-store.js"
import { log } from "../util/log.js"

export const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3210),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  /** Explicit browser executable; otherwise auto-discovered. */
  browserExecutable: z.string().optional(),
  /** Playwright channel name (e.g. "chrome", "msedge"); otherwise auto-discovered. */
  browserChannel: z.string().optional(),
  /** Headless browser (NOT recommended: ChatGPT bot-protection may refuse). */
  headless: z.boolean().default(false),
  /** Invisible browser: window moved off-screen (headed fingerprint, nothing visible). */
  offscreen: z.boolean().default(false),
  /** Completion timeout for a single ChatGPT response, ms. */
  responseTimeoutMs: z.number().int().default(300_000),
  /** Navigation timeout, ms. */
  navigationTimeoutMs: z.number().int().default(60_000),
  /** Text-stability debounce polls after completion signal. */
  stabilityPolls: z.number().int().default(2),
})

export type Config = z.infer<typeof ConfigSchema>

export const defaultConfig = (): Config => ConfigSchema.parse({})

export async function loadConfig(): Promise<Config> {
  const raw = await readJson<unknown>(configPath(), {})
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    log.warn("invalid config.json, using defaults", { issues: parsed.error.issues.length })
    return defaultConfig()
  }
  return parsed.data
}

export async function saveConfig(config: Config): Promise<void> {
  await atomicWriteJson(configPath(), config)
}
