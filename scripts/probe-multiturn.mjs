#!/usr/bin/env node
/** Probe 7: multi-turn — prove the SECOND response is captured, not the first. */
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
await page.waitForTimeout(5_000)

const m1 = `TURN1_${Date.now().toString(36)}`
const m2 = `TURN2_${Date.now().toString(36)}`
const ask = (m) => `Reply with exactly one JSON object and nothing else:\n{"type":"final","content":"${m}"}`

try {
  const s1 = await submitPrompt(page, ask(m1), 30_000)
  const c1 = await awaitResponseCompletion(page, s1.beforeAssistant, 120_000, 2)
  console.log(JSON.stringify({ turn: 1, ok: c1.text.includes(m1) && !c1.text.includes(m2), text: c1.text.slice(0, 120) }))

  const s2 = await submitPrompt(page, ask(m2), 30_000)
  const c2 = await awaitResponseCompletion(page, s2.beforeAssistant, 120_000, 2)
  const secondOk = c2.text.includes(m2) && !c2.text.includes(m1)
  console.log(JSON.stringify({ turn: 2, ok: secondOk, text: c2.text.slice(0, 120) }))

  // final: assistant count should be 2 and neither read crossed turns
  console.log(JSON.stringify({ multiTurnResponseIdentification: c1.text.includes(m1) && secondOk }))
  await ensureDir("proof/private")
  await page.screenshot({ path: "proof/private/multi-turn.png" })
} catch (e) {
  await page.screenshot({ path: "proof/private/multi-turn-failure.png" }).catch(() => {})
  console.log(JSON.stringify({ error: e.message, url: page.url() }))
  process.exitCode = 1
} finally {
  await ctx.close()
}
