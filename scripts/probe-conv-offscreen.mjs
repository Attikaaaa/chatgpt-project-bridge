#!/usr/bin/env node
/** Probe: beszélgetés-oldal offscreen — mountol-e a composer 120s alatt? */
import { chromium } from "playwright-core"
import { readFileSync, readdirSync } from "node:fs"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"

let convUrl = process.argv[2]
if (!convUrl) {
  const { readdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const sd = join(browserProfileDir(), "..", "sessions")
  for (const f of readdirSync(sd)) {
    if (!f.endsWith(".json")) continue
    const r = JSON.parse(readFileSync(join(sd, f), "utf8"))
    if (r.workspaceDir?.includes("real-ws")) { convUrl = r.conversation.url; break }
  }
}
if (!convUrl) { console.log("no conversation found"); process.exit(1) }

const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = {
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
  args: ["--window-position=-2000,-2000"],
}
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(convUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })
for (const wait of [15, 45, 90, 120]) {
  await page.waitForTimeout(wait === 15 ? 15_000 : 30_000)
  const state = await page.evaluate(() => {
    const els = document.querySelectorAll('#prompt-textarea, [data-testid="prompt-textarea"], div[contenteditable="true"]')
    let composer = "none"
    for (const e of Array.from(els)) {
      const r = e.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) { composer = `${Math.round(r.width)}x${Math.round(r.height)}`; break }
    }
    return { visState: document.visibilityState, composer, hasFocus: document.hasFocus() }
  })
  console.log(JSON.stringify({ after: wait + "s", ...state }))
}
ensureDir("proof/private")
await page.screenshot({ path: "proof/private/conv-offscreen.png" })
await ctx.close()
