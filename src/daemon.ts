import { buildServer } from "./server/http.js"
import { TurnService } from "./server/turn-service.js"
import { PlaywrightChatBackend } from "./browser/playwright.js"
import { loadConfig } from "./state/config.js"
import { rotateToken, loadToken } from "./security/auth.js"
import { attachFileSink } from "./security/redaction.js"
import { logsDir } from "./state/paths.js"
import { ensureDir } from "./state/atomic-store.js"
import { log } from "./util/log.js"
import type { ChatBackend } from "./browser/backend.js"

export interface ServeOptions {
  port?: number
  host?: string
  headless?: boolean
  verboseBodies?: boolean
  screenshotsDir?: string
}

export async function serve(opts: ServeOptions = {}): Promise<{ close: () => Promise<void>; port: number }> {
  const cfg = await loadConfig()
  if (opts.verboseBodies) log.verboseBodies = true
  await ensureDir(logsDir())
  attachFileSink(logsDir() + "/cgpt.log")

  const port = opts.port ?? cfg.port
  const host = opts.host ?? cfg.host

  let token = await loadToken()
  if (!token) {
    token = await rotateToken()
    log.info("generated new local auth token")
  }

  const backend: ChatBackend = new PlaywrightChatBackend({
    headless: opts.headless ?? cfg.headless,
    executablePath: cfg.browserExecutable,
    channel: cfg.browserChannel,
    navigationTimeoutMs: cfg.navigationTimeoutMs,
    stabilityPolls: cfg.stabilityPolls,
    screenshotsDir: opts.screenshotsDir,
  })

  const turns = new TurnService(backend, cfg.responseTimeoutMs)
  const app = await buildServer(turns, { host, port, token })

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    log.info("shutting down", { signal })
    try {
      await app.close()
    } catch {
      /* noop */
    }
    try {
      await backend.close()
    } catch {
      /* noop */
    }
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  await app.listen({ port, host })
  log.info("bridge listening", { host, port, model: "chatgpt-project-web" })
  return {
    port,
    close: async () => {
      await app.close()
      await backend.close()
    },
  }
}
