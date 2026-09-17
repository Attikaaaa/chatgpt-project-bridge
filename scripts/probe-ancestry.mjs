#!/usr/bin/env node
/** Probe 6: find the element subtree that actually contains the assistant response. */
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
await page.waitForTimeout(5_000)

const marker = `ANCESTOR_${Date.now().toString(36)}`
await page.locator("#mobile-composer-prompt, [data-testid=\"prompt-textarea\"], textarea").first().fill(`Reply with exactly: ${marker}`)
await page.keyboard.press("Enter")
await page.waitForTimeout(20_000)
console.log(JSON.stringify({ url: page.url(), marker }))

const ancestry = await page.evaluate((marker) => {
  function describe(el) {
    const attrs = {}
    for (const a of el.attributes || []) attrs[a.name] = a.value.slice(0, 60)
    return { tag: el.tagName, attrs }
  }
  function pathToRoot(el) {
    const path = []
    let cur = el
    while (cur && cur !== document.documentElement && path.length < 30) {
      path.push(describe(cur))
      cur = cur.parentElement
    }
    return path.reverse()
  }
  const hits = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    if (node.textContent && node.textContent.includes(marker)) {
      let el = node.parentElement
      hits.push(pathToRoot(el))
      if (hits.length >= 2) break
    }
  }
  return hits
}, marker)
console.log(JSON.stringify(ancestry, null, 2))
await ctx.close()
