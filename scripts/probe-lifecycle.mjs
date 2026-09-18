#!/usr/bin/env node
/** Probe: off-screen + Page.setWebLifecycleState(active) → mountol-e a composer? */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"

const projectUrl = "https://chatgpt.com/g/g-p-6aaccc2bf458819189f3963af60e24d6/project"
const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = {
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
  args: ["--window-position=-32000,-32000"],
}
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })

const cdp = await ctx.newCDPSession(page)
await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch((e) => console.log("cdp err:", e.message))
const vis = await page.evaluate(() => document.visibilityState)
await page.waitForTimeout(6_000)
const vis2 = await page.evaluate(() => document.visibilityState)
const sel = '[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, div[contenteditable="true"], textarea'
const composer = page.locator(sel).first()
const composerVisible = await composer.isVisible().catch(() => false)

let filled = false
if (composerVisible) {
  try {
    await composer.click({ force: true, timeout: 10_000 })
    await composer.fill('Reply with exactly one JSON object and nothing else:\n{"type":"final","content":"OFFSCREEN2_OK"}', { force: true, timeout: 15_000 })
    filled = true
    const send = page.locator('[data-testid="send-button"], button[aria-label*="Send"]').first()
    await send.click({ force: true, timeout: 8_000 }).catch(async () => composer.press("Enter"))
    await page.waitForTimeout(15_000)
  } catch (e) {
    console.log(JSON.stringify({ fillError: e.message.slice(0, 120) }))
  }
}
const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ")
console.log(JSON.stringify({ vis, vis2, composerVisible, filled, containsOk: body.includes("OFFSCREEN2_OK") }))
await ctx.close()
