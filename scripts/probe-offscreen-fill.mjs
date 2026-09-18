#!/usr/bin/env node
/** Probe: off-screen composer fill + submit — mi működik? */
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
const t0 = Date.now()
await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })
console.log(JSON.stringify({ navigated: true, url: page.url(), ms: Date.now() - t0 }))

const sel = '[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, div[contenteditable="true"], textarea'
const composer = page.locator(sel).first()
await composer.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {})
console.log(JSON.stringify({ composerVisible: await composer.isVisible().catch(() => false) }))

const msg = `Reply with exactly one JSON object and nothing else:\n{"type":"final","content":"OFFSCREEN_OK"}`

// Attempt 1: fill with force
let method = "fill-force"
try {
  await composer.click({ force: true, timeout: 10_000 })
  await composer.fill(msg, { force: true, timeout: 15_000 })
  console.log(JSON.stringify({ method, ok: true }))
} catch (e) {
  console.log(JSON.stringify({ method, ok: false, error: e.message.slice(0, 100) }))
  method = "execCommand"
  try {
    await composer.click({ force: true, timeout: 10_000 })
    await page.evaluate(() => {
      const el = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], div[contenteditable="true"], textarea')
      el?.focus()
      document.execCommand("selectAll", false)
      document.execCommand("insertText", false, window.__msg ?? "")
    }, undefined).catch(() => {})
    // pass message properly
    await page.evaluate((text) => {
      const el = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], div[contenteditable="true"], textarea')
      el?.focus()
      document.execCommand("selectAll", false)
      document.execCommand("insertText", false, text)
    }, msg)
    console.log(JSON.stringify({ method, ok: true }))
  } catch (e2) {
    console.log(JSON.stringify({ method, ok: false, error: e2.message.slice(0, 100) }))
  }
}

// Submit attempt
let submitted = "not-tried"
try {
  const send = page.locator('[data-testid="send-button"], button[aria-label*="Send"]').first()
  await send.click({ force: true, timeout: 8_000 })
  submitted = "clicked"
} catch (e) {
  try {
    await composer.press("Enter")
    submitted = "enter"
  } catch (e2) {
    submitted = "failed: " + e2.message.slice(0, 60)
  }
}
await page.waitForTimeout(12_000)
const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ")
console.log(JSON.stringify({ submitted, url: page.url(), containsOk: body.includes("OFFSCREEN_OK"), ms: Date.now() - t0 }))
await ctx.close()
