#!/usr/bin/env node
/** Probe 4: real submit → completion → extraction loop (anonymous UI if not logged in). */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"
import { submitPrompt, awaitResponseCompletion } from "../dist/browser/completion.js"

const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = { headless: false, viewport: { width: 1440, height: 900 } }
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 90_000 })
await page.waitForTimeout(6_000)

const marker = `PONG_${Date.now().toString(36)}`
const message = `Reply with exactly one JSON object and nothing else:\n{"type":"final","content":"${marker}"}`
console.log(JSON.stringify({ submitting: marker }))

try {
  const t0 = Date.now()
  const submit = await submitPrompt(page, message, 30_000)
  console.log(JSON.stringify({ submit, url: page.url() }))
  const completion = await awaitResponseCompletion(page, submit.beforeAssistant, 120_000, 2)
  console.log(
    JSON.stringify({ ms: Date.now() - t0, assistantIndex: completion.assistantIndex, text: completion.text.slice(0, 400) }, null, 2),
  )
  await ensureDir("proof/private")
  await page.screenshot({ path: "proof/private/send-loop.png" })
  console.log(JSON.stringify({ ok: completion.text.includes(marker) }))
} catch (e) {
  await ensureDir("proof/private")
  await page.screenshot({ path: "proof/private/send-loop-failure.png" }).catch(() => {})
  console.log(JSON.stringify({ error: e.message, url: page.url() }))
} finally {
  await ctx.close()
}
