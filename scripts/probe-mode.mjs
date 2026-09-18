#!/usr/bin/env node
/** Probe: adott módban (headless|offscreen|headed) mit látunk chatgpt.com-on? */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"

const mode = process.argv[2] ?? "headless"
const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = {
  headless: mode === "headless",
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
}
if (mode === "offscreen") opts.args = ["--window-position=-32000,-32000"]
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel

const t0 = Date.now()
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
try {
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 })
} catch (e) {
  console.log(JSON.stringify({ mode, navError: e.message.slice(0, 120), ms: Date.now() - t0 }))
  await page.screenshot({ path: `proof/private/probe-${mode}-timeout.png` }).catch(() => {})
  await ctx.close()
  process.exit(0)
}
await page.waitForTimeout(8_000)
const composer = await page
  .locator('[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, div[contenteditable="true"], textarea')
  .first()
  .isVisible({ timeout: 5_000 })
  .catch(() => false)
const loginBtn = await page
  .locator('button:has-text("Log in"), a:has-text("Log in")')
  .first()
  .isVisible({ timeout: 2_000 })
  .catch(() => false)
const bodyHead = (await page.locator("body").innerText().catch(() => "")).slice(0, 200).replace(/\s+/g, " ")
await ensureDir("proof/private")
await page.screenshot({ path: `proof/private/probe-${mode}.png` })
console.log(JSON.stringify({ mode, url: page.url(), composer, loginBtn, ms: Date.now() - t0, bodyHead }, null, 2))
await ctx.close()
