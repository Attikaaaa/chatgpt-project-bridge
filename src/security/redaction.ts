import { log } from "../util/log.js"

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]"],
  [/(authorization"?\s*[:=]\s*"?)[^",}\s]+/gi, "$1[REDACTED]"],
  [/(api[-_]?key"?\s*[:=]\s*"?)[^",}\s]+/gi, "$1[REDACTED]"],
  [/(token"?\s*[:=]\s*"?)[^",}\s]+/gi, "$1[REDACTED]"],
]

const ENV_KEY_HINT = /([A-Z0-9_]*?(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)(["']?)[^\s"']+\3/gi

/** Redact obvious secrets from a string before it reaches logs. */
export function redact(text: string): string {
  let out = text
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement)
  }
  out = out.replace(ENV_KEY_HINT, "$1$3[REDACTED]$3")
  return out
}

/** Truncate long content; used for non-debug logs of prompt activity. */
export function preview(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return redact(clean.length > max ? clean.slice(0, max) + "…" : clean)
}

export function safeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === "string" ? preview(v) : v
  }
  return out
}

let sinkAttached = false

export async function attachFileSink(path: string): Promise<void> {
  if (sinkAttached) return
  sinkAttached = true
  const { appendFile, mkdir } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  try {
    await mkdir(dirname(path), { recursive: true })
  } catch {
    /* best effort */
  }
  log.on("entry", (entry: unknown) => {
    appendFile(path, JSON.stringify(entry) + "\n", "utf8").catch(() => {
      /* logging must never crash the daemon */
    })
  })
  log.debug("log file sink attached", { dir: dirname(path) })
}
