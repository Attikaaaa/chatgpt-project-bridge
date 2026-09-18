#!/usr/bin/env node
/** Debug: Project oldal DOM inventory. */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"

const projectUrl = process.argv[2] ?? "https://chatgpt.com/g/g-p-6aaccc2bf458819189f3963af60e24d6/project"
const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = { headless: false, viewport: { width: 1440, height: 900 } }
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })
await page.waitForTimeout(12_000)

const info = await page.evaluate(() => {
  const out = { url: location.href, title: document.title }
  out.composerCandidates = [...document.querySelectorAll('[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, div[contenteditable="true"], textarea')].map((e) => ({
    tag: e.tagName,
    id: e.id,
    testid: e.getAttribute("data-testid"),
    placeholder: e.getAttribute("placeholder") ?? e.getAttribute("data-placeholder"),
    aria: e.getAttribute("aria-label"),
    visible: !!(e.offsetWidth || e.offsetHeight),
  }))
  out.buttons = [...document.querySelectorAll('button, a[role="button"]')].slice(0, 40).map((b) => ({
    label: (b.getAttribute("aria-label") ?? b.textContent ?? "").trim().slice(0, 40),
    testid: b.getAttribute("data-testid"),
  })).filter((b) => b.label)
  return out
})
await ensureDir("proof/private")
await page.screenshot({ path: "proof/private/project-page.png" })
console.log(JSON.stringify(info, null, 2))
await ctx.close()
