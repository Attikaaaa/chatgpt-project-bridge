#!/usr/bin/env node
/** Debug: mi váltja ki a login CTA detektort bejelentkezett állapotban? */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"
import { LOGIN_SIGNALS } from "../dist/browser/selectors.js"

const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = { headless: false, viewport: { width: 1440, height: 900 } }
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 })
await page.waitForTimeout(10_000)

const url = page.url()
const composer = await page
  .locator('[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, div[contenteditable="true"], textarea[aria-label*="Chat"]')
  .first()
  .isVisible({ timeout: 10_000 })
  .catch(() => false)

const found = []
for (const sel of [LOGIN_SIGNALS.loginLink, LOGIN_SIGNALS.loginButton, 'a[href*="auth/login"]', 'button:has-text("Log in")', 'a:has-text("Log in")']) {
  try {
    const loc = page.locator(sel)
    const n = await loc.count()
    for (let i = 0; i < Math.min(n, 8); i++) {
      if (await loc.nth(i).isVisible({ timeout: 250 })) {
        const el = loc.nth(i)
        found.push({
          selector: sel,
          text: (await el.innerText().catch(() => "")).slice(0, 40),
          href: await el.getAttribute("href").catch(() => null),
        })
      }
    }
  } catch {}
}
await ensureDir("proof/private")
await page.screenshot({ path: "proof/private/auth-debug.png" })
console.log(JSON.stringify({ url, composer, visibleLoginElements: found }, null, 2))
await ctx.close()
