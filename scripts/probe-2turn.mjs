#!/usr/bin/env node
/** Probe: 2-turn flow offscreen — a 2. turn (continue) composer állapota. */
import { chromium } from "playwright-core"
import { discoverBrowser } from "../dist/browser/launch.js"
import { browserProfileDir } from "../dist/state/paths.js"
import { ensureDir } from "../dist/state/atomic-store.js"
import { submitPrompt, awaitResponseCompletion } from "../dist/browser/completion.js"

const projectUrl = "https://chatgpt.com/g/g-p-6aaccc2bf458819189f3963af60e24d6/project"
const profileDir = browserProfileDir()
await ensureDir(profileDir)
const discovered = await discoverBrowser({})
const opts = {
  headless: false,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
  args: ["--window-position=-2000,-2000"],
}
if (discovered.executablePath) opts.executablePath = discovered.executablePath
else if (discovered.channel) opts.channel = discovered.channel
const ctx = await chromium.launchPersistentContext(profileDir, opts)
const page = ctx.pages()[0] ?? (await ctx.newPage())

async function dumpComposerState(tag) {
  const state = await page.evaluate((sel) => {
    const out = []
    for (const e of Array.from(document.querySelectorAll(sel))) {
      const r = e.getBoundingClientRect()
      out.push({ tag: e.tagName + "/" + (e.id || "-"), rect: `${Math.round(r.width)}x${Math.round(r.height)}`, visible: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" })
    }
    return { candidates: out, hasFocus: document.hasFocus(), vis: document.visibilityState }
  }, '[data-testid="prompt-textarea"], #prompt-textarea, #mobile-composer-prompt, div[contenteditable="true"], textarea[aria-label*="Chat"], textarea[placeholder*="Message"], textarea[placeholder*="Ask"]')
  console.log(JSON.stringify({ tag, ...state }))
}

try {
  await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await dumpComposerState("after-nav-project")

  const msg1 = 'Reply with exactly one JSON object and nothing else:\n{"type":"final","content":"TURN1_BG_OK"}'
  const s1 = await submitPrompt(page, msg1, 30_000, { force: true })
  console.log(JSON.stringify({ turn1Submitted: true }))
  const c1 = await awaitResponseCompletion(page, s1.beforeAssistant, 240_000, 2)
  console.log(JSON.stringify({ turn1Response: c1.text.slice(0, 100) }))

  await dumpComposerState("before-turn2")
  const msg2 = 'Reply with exactly one JSON object and nothing else:\n{"type":"final","content":"TURN2_BG_OK"}'
  const s2 = await submitPrompt(page, msg2, 30_000, { force: true })
  console.log(JSON.stringify({ turn2Submitted: true }))
  const c2 = await awaitResponseCompletion(page, s2.beforeAssistant, 240_000, 2)
  console.log(JSON.stringify({ turn2Response: c2.text.slice(0, 100) }))
  console.log(JSON.stringify({ RESULT: c1.text.includes("TURN1_BG_OK") && c2.text.includes("TURN2_BG_OK") ? "TWO_TURNS_OFFSCREEN_OK" : "MISMATCH" }))
} catch (e) {
  console.log(JSON.stringify({ error: e.message.slice(0, 200), url: page.url().slice(0, 90) }))
  await dumpComposerState("error-state").catch(() => {})
} finally {
  await ctx.close()
}
