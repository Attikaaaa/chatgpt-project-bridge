#!/usr/bin/env node
/** Probe 5: DOM inventory of an anonymous conversation page (post-send). */
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

const marker = `DOMPROBE_${Date.now().toString(36)}`
await page.locator("#mobile-composer-prompt, [data-testid=\"prompt-textarea\"], textarea").first().fill(`Reply with exactly: ${marker}`)
await page.keyboard.press("Enter")
await page.waitForTimeout(15_000)
console.log(JSON.stringify({ url: page.url() }))

const info = await page.evaluate(() => {
  const out = { roleAttrs: {}, testids: [], structures: [] }
  out.roleAttrs.assistant = document.querySelectorAll('[data-message-author-role="assistant"]').length
  out.roleAttrs.user = document.querySelectorAll('[data-message-author-role="user"]').length
  out.testids = [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")))]
  // sample structure of main
  const main = document.querySelector("main")
  if (main) {
    const walk = (el, depth) => {
      if (depth > 4 || out.structures.length > 40) return
      const attrs = [...el.attributes].map((a) => `${a.name}=${a.value.slice(0, 40)}`).join(" ")
      out.structures.push(`${"  ".repeat(depth)}<${el.tagName.toLowerCase()} ${attrs}> ${(el.textContent ?? "").slice(0, 60)}`)
      for (const c of [...el.children].slice(0, 6)) walk(c, depth + 1)
    }
    walk(main, 0)
  }
  return out
})
console.log(JSON.stringify(info, null, 2))
await ctx.close()
