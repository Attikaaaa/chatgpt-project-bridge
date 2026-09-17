#!/usr/bin/env node
/** Probe 3: inspect composer DOM + test-id inventory on chatgpt.com landing page. */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"

const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = { headless: false, viewport: { width: 1440, height: 900 } }
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 })
await page.waitForTimeout(8_000)

const info = await page.evaluate(() => {
  const candidates = []
  // find likely composer elements
  const els = document.querySelectorAll(
    'textarea, [contenteditable="true"], [data-testid*="prompt"], input[type="text"]',
  )
  for (const el of els) {
    candidates.push({
      tag: el.tagName,
      id: el.id,
      testid: el.getAttribute("data-testid"),
      placeholder: el.getAttribute("placeholder") ?? el.getAttribute("data-placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
      classes: (el.className ?? "").toString().slice(0, 80),
    })
  }
  // collect all data-testids on page (deduped, first 60)
  const testids = [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")))]
  const buttons = [...document.querySelectorAll("button")]
    .slice(0, 40)
    .map((b) => ({ label: b.getAttribute("aria-label") ?? b.innerText?.slice(0, 30), testid: b.getAttribute("data-testid") }))
  return { candidates, testids: testids.slice(0, 60), buttons }
})
console.log(JSON.stringify(info, null, 2))
await ctx.close()
