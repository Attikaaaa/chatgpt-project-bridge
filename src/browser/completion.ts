import type { Page, Locator } from "playwright-core"
import { SELECTORS } from "./selectors.js"
import { CodedError } from "./backend.js"
import { log } from "../util/log.js"

/**
 * The page can contain several composer-like elements (a hidden 0x0
 * textarea mirror plus the real contenteditable). Pick the first VISIBLE
 * candidate, preferring known test-ids/ids over generic selectors.
 */
export async function composerLocator(page: Page): Promise<Locator> {
  const all = page.locator(SELECTORS.promptComposer)
  const count = await all.count().catch(() => 0)
  for (let i = 0; i < count; i++) {
    const candidate = all.nth(i)
    if (await candidate.isVisible().catch(() => false)) return candidate
  }
  return all.first()
}

export async function isComposerVisible(page: Page, timeoutMs = 15_000): Promise<boolean> {
  // Poll instead of waitFor: the composer element often mounts LATE
  // (off-screen windows hydrate slowly), so the candidate set changes over
  // time and a one-shot waitFor on the current locator can miss it.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const composer = await composerLocator(page)
    if (await composer.isVisible().catch(() => false)) return true
    await page.waitForTimeout(1_000)
  }
  return false
}

/** Assistant-message locator for the current UI variant. */
async function assistantLocatorFor(page: Page): Promise<Locator> {
  const roleCount = await page
    .locator(SELECTORS.assistantMessages)
    .count()
    .catch(() => 0)
  return roleCount > 0 ? page.locator(SELECTORS.assistantMessages) : page.locator(SELECTORS.conversationTurns)
}

async function assistantCount(page: Page): Promise<number> {
  const loc = await assistantLocatorFor(page)
  return loc.count().catch(() => 0)
}

/** True if the locator targets role-attributed assistant messages (exact text extraction). */
async function isRoleBased(page: Page): Promise<boolean> {
  const roleCount = await page
    .locator(SELECTORS.assistantMessages)
    .count()
    .catch(() => 0)
  return roleCount > 0
}

async function countGenerating(page: Page): Promise<boolean> {
  try {
    const stop = page.locator(SELECTORS.stopButton).first()
    return await stop.isVisible()
  } catch {
    return false
  }
}

async function extractText(page: Page, index: number): Promise<string> {
  const loc = await assistantLocatorFor(page)
  const msg = loc.nth(index)
  try {
    return (await msg.innerText({ timeout: 5_000 })).trim()
  } catch {
    return ""
  }
}

export interface SubmitOutcome {
  beforeAssistant: number
  afterAssistant: number
  userBefore: number
}

export interface SubmitOptions {
  /** Skip actionability checks and use DOM-level text insertion (required
   * for off-screen windows where Playwright's input pipeline times out).
   * Submission is still verified by outcome. */
  force?: boolean
}

/** Composer selector usable inside page.evaluate. */
const COMPOSER_DOM_SELECTOR =
  '#prompt-textarea, [data-testid="prompt-textarea"], #mobile-composer-prompt, div[contenteditable="true"], textarea'

/**
 * Off-screen windows throttle Playwright's input pipeline (fill/typing time
 * out), but DOM-level execCommand insertion works and fires proper input
 * events (React picks it up and enables the send button).
 * NOTE: the page may contain a hidden 0x0 textarea BEFORE the real
 * contenteditable in document order — always pick the first VISIBLE match.
 */
async function domFill(page: Page, message: string): Promise<void> {
  await page.evaluate(
    ({ selector, text }) => {
      const doc = globalThis as unknown as { document: any }
      const all = doc.document.querySelectorAll(selector) as unknown as Array<any>
      let el: any = null
      for (const candidate of Array.from(all)) {
        const r = candidate.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          el = candidate
          break
        }
      }
      if (!el) throw new Error("no visible composer element in DOM")
      el.focus()
      doc.document.execCommand("selectAll", false)
      doc.document.execCommand("insertText", false, text)
    },
    { selector: COMPOSER_DOM_SELECTOR, text: message },
  )
}

/** Composer content length via DOM (works for contenteditable off-screen). */
async function composerContentLength(page: Page): Promise<number> {
  return page
    .evaluate((selector) => {
      const doc = globalThis as unknown as { document: any }
      const all = doc.document.querySelectorAll(selector) as unknown as Array<any>
      let el: any = null
      for (const candidate of Array.from(all)) {
        const r = candidate.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          el = candidate
          break
        }
      }
      if (!el) return -1
      return ((el as any).value ?? el.textContent ?? "").length
    }, COMPOSER_DOM_SELECTOR)
    .catch(() => -1)
}

/**
 * Submit a prompt and verify it actually appeared (assistant count grows or
 * URL becomes a conversation URL). Never retries when submission may have
 * gone through (duplicate-prompt protection).
 */
export async function submitPrompt(
  page: Page,
  message: string,
  timeoutMs: number,
  opts: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const composer = await composerLocator(page)
  if (!(await isComposerVisible(page, 45_000))) {
    throw new CodedError("Prompt composer not found on the page.", "BROWSER_COMPOSER_MISSING")
  }
  const beforeAssistant = await assistantCount(page)
  const beforeUrl = page.url()

  let clicked = false
  if (opts.force === true) {
    // Off-screen mode: DOM insertion (verified) + submit via Enter on the
    // focused composer (force-clicks are unreliable without real rendering);
    // send-button click only as backup. All failure modes stay fail-closed.
    await page.waitForTimeout(2_000)
    let inserted = false
    for (let attempt = 1; attempt <= 6 && !inserted; attempt++) {
      await composer.click({ force: true, timeout: 10_000 }).catch(() => {})
      if (attempt % 2 === 1) {
        await domFill(page, message).catch(() => {})
      } else {
        await page.keyboard.insertText(message).catch(() => {})
      }
      await page.waitForTimeout(1_500)
      const len = await composerContentLength(page)
      if (len > 0) inserted = true
      else log.debug("composer insert attempt failed", { attempt, len })
    }
    if (!inserted) {
      const len = await composerContentLength(page)
      throw new CodedError(
        `Could not insert the prompt text into the composer (len=${len}).`,
        "BROWSER_SUBMIT_FAILED",
      )
    }

    const evidenceAppeared = async (): Promise<boolean> => {
      const assistantNow = await assistantCount(page)
      if (assistantNow > beforeAssistant) return true
      const urlNow = page.url()
      return urlNow !== beforeUrl && /\/(?:c|uc)\//.test(urlNow)
    }

    // Primary: Enter on the focused composer.
    await page.keyboard.press("Enter")
    const evidenceDeadline = Date.now() + 25_000
    while (Date.now() < evidenceDeadline) {
      if (await evidenceAppeared()) return { beforeAssistant, afterAssistant: beforeAssistant + 1, userBefore: beforeAssistant }
      await page.waitForTimeout(500)
    }
    // Backup: send-button force click.
    try {
      const sendButton = page.locator(SELECTORS.sendButton).first()
      await sendButton.waitFor({ state: "visible", timeout: 3_000 })
      const disabled = await sendButton.isDisabled().catch(() => true)
      if (!disabled) {
        await sendButton.click({ force: true, timeout: 8_000 })
        clicked = true
      }
    } catch {
      clicked = false
    }
    if (!clicked) {
      await page.keyboard.press("Enter")
    }
  } else {
    await composer.click({ timeout: 15_000 })
    await composer.fill(message, { timeout: 30_000 })

    const sendButton = page.locator(SELECTORS.sendButton).first()
    try {
      await sendButton.waitFor({ state: "visible", timeout: 5_000 })
      await sendButton.click({ timeout: 5_000 })
      clicked = true
    } catch {
      clicked = false
    }
    if (!clicked) {
      await composer.press("Enter")
    }
  }

  // Verify submission: assistant count grows OR URL becomes a conversation.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const assistantNow = await assistantCount(page)
    const urlNow = page.url()
    if (assistantNow > beforeAssistant) {
      return { beforeAssistant, afterAssistant: assistantNow, userBefore: beforeAssistant }
    }
    if (urlNow !== beforeUrl && /\/(?:c|uc)\//.test(urlNow)) {
      return { beforeAssistant, afterAssistant: assistantNow, userBefore: beforeAssistant }
    }
    // If the composer still holds our text and no send happened, submission failed.
    const remaining = await composer
      .inputValue()
      .then((t) => t.trim().length > 0)
      .catch(() =>
        composer
          .innerText()
          .then((t) => t.trim().length > 0)
          .catch(() => false),
      )
    if (remaining && !clicked) {
      throw new CodedError(
        "Prompt submission failed: the composer still contains the message and no new message appeared.",
        "BROWSER_SUBMIT_FAILED",
      )
    }
    await page.waitForTimeout(300)
  }
  throw new CodedError(
    "Prompt submission could not be confirmed (no new message appeared). Not retrying to avoid duplicate submission.",
    "AMBIGUOUS_SUBMIT",
  )
}

/** Conversation id from a chatgpt.com conversation URL (/c/, /uc/, or project-scoped). */
export function conversationIdFromUrl(url: string): string | null {
  return url.match(/\/(?:c|uc)\/([0-9a-f-]{16,})/i)?.[1] ?? null
}

export interface CompletionResult {
  text: string
  assistantIndex: number
}

/**
 * Wait for the response to THIS submission to finish generating.
 * Primary completion signal: generation control (stop button) gone.
 * Secondary: text stability debounce (stabilityPolls identical reads).
 * Reads only the message at beforeAssistant index — never a previous one.
 */
export async function awaitResponseCompletion(
  page: Page,
  beforeAssistant: number,
  timeoutMs: number,
  stabilityPolls = 2,
): Promise<CompletionResult> {
  const deadline = Date.now() + timeoutMs
  // Phase 1: wait for a new assistant message (or conversation turn) to exist.
  let assistantIndex = -1
  let roleBased = await isRoleBased(page)
  while (Date.now() < deadline) {
    const count = await assistantCount(page)
    roleBased = await isRoleBased(page)
    if (count > beforeAssistant) {
      assistantIndex = beforeAssistant
      break
    }
    await page.waitForTimeout(500)
  }
  if (assistantIndex === -1) {
    throw new CodedError(
      `Timed out after ${timeoutMs}ms waiting for ChatGPT to produce a new assistant message.`,
      "BROWSER_RESPONSE_TIMEOUT",
    )
  }

  // Phase 2: wait for generation to finish (stop control gone + stability
  // debounce; on the octane UI the message LI also gains data-message-complete).
  let stableCount = 0
  let lastText = ""
  let sawGeneration = false
  while (Date.now() < deadline) {
    const generating = await countGenerating(page)
    if (generating) {
      sawGeneration = true
      stableCount = 0
      await page.waitForTimeout(750)
      continue
    }
    const text = await extractText(page, assistantIndex)
    if (text.length > 0 && text === lastText) {
      stableCount++
    } else {
      stableCount = 0
      lastText = text
    }
    const loc = await assistantLocatorFor(page)
    const completeAttr = await loc
      .nth(assistantIndex)
      .getAttribute("data-message-complete")
      .catch(() => null)
    const needed = completeAttr !== null ? 1 : stabilityPolls
    if (stableCount >= needed) {
      return { text: roleBased ? lastText : stripTurnNoise(lastText), assistantIndex }
    }
    await page.waitForTimeout(750)
  }
  // Deadline hit: if we never saw generation and have text, accept with warning.
  if (!sawGeneration && lastText.length > 0) {
    log.warn("completion timeout without observed generation; accepting last stable text")
    return { text: roleBased ? lastText : stripTurnNoise(lastText), assistantIndex }
  }
  throw new CodedError(
    `Timed out after ${timeoutMs}ms waiting for the ChatGPT response to finish.`,
    "BROWSER_RESPONSE_TIMEOUT",
  )
}

/**
 * On the limited (non-role-attributed) UI, the "assistant message" locator
 * actually points at a whole conversation turn; strip the echoed user
 * prompt prefix so downstream parsing sees the model's output only.
 */
function stripTurnNoise(text: string): string {
  // The turn typically renders: user prompt, then the assistant reply.
  // Heuristic: if the text contains our JSON marker, extract from the first '{'.
  const brace = text.indexOf("{")
  if (brace > 0) return text.slice(brace).trim()
  return text
}

export async function captureFailureScreenshot(page: Page, path: string): Promise<void> {
  try {
    await page.screenshot({ path, fullPage: false })
    log.warn("captured failure screenshot", { path })
  } catch (e) {
    log.warn("failed to capture screenshot", { error: String((e as Error).message) })
  }
}
