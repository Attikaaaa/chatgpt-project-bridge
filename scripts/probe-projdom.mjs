#!/usr/bin/env node
/** Probe: project oldal DOM offscreen vs headed — mi hiányzik? */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"

const mode = process.argv[2] ?? "offscreen"
const projectUrl = "https://chatgpt.com/g/g-p-6aaccc2bf458819189f3963af60e24d6/project"
const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = {
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
}
if (mode === "offscreen") opts.args = ["--window-position=-32000,-32000"]
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })
await page.waitForTimeout(15_000)
const info = await page.evaluate(() => {
  const out = { url: location.href, candidates: [], contenteditableCount: 0, textareaCount: 0 }
  const els = document.querySelectorAll('[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, div[contenteditable="true"], textarea')
  out.candidates = [...els].map((e) => {
    const r = e.getBoundingClientRect()
    return { tag: e.tagName, id: e.id, testid: e.getAttribute("data-testid"), rect: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`, contentEditable: e.getAttribute("contenteditable") }
  })
  out.contenteditableCount = document.querySelectorAll('div[contenteditable="true"]').length
  out.textareaCount = document.querySelectorAll("textarea").length
  const btns = [...document.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim()).filter((t) => t)
  out.buttonSample = [...new Set(btns)].slice(0, 25)
  return out
})
await ensureDir("proof/private")
await page.screenshot({ path: `proof/private/proj-${mode}.png` })
console.log(JSON.stringify(info, null, 2))
await ctx.close()
