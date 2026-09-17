#!/usr/bin/env node
/** Probe 2: raw page state of chatgpt.com in the persistent profile + screenshot. */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"

const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = { headless: process.argv.includes("--headless"), viewport: { width: 1440, height: 900 } }
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 })
await page.waitForTimeout(12_000)
const url = page.url()
const title = await page.title()
const composer = await page.locator('[data-testid="prompt-textarea"], #prompt-textarea, div[contenteditable="true"]').first().isVisible({ timeout: 5000 }).catch(() => false)
const loginLink = await page.locator('a[href*="auth/login"]').first().isVisible({ timeout: 2000 }).catch(() => false)
const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, 500)
await ensureDir("proof/private")
await page.screenshot({ path: "proof/private/auth-state.png", fullPage: false })
console.log(JSON.stringify({ url, title, composer, loginLink, bodyTextSample: bodyText }, null, 2))
await ctx.close()
