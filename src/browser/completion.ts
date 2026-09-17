import type { Page, Locator } from "playwright-core"
import { SELECTORS } from "./selectors.js"
import { CodedError } from "./backend.js"
import { log } from "../util/log.js"

export function composerLocator(page: Page): Locator {
  return page.locator(SELECTORS.promptComposer).first()
}

export async function isComposerVisible(page: Page, timeoutMs = 15_000): Promise<boolean> {
  try {
    await composerLocator(page).waitFor({ state: "visible", timeout: timeoutMs })
    return true
  } catch {
    return false
  }
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

/**
 * Submit a prompt and verify it actually appeared (assistant count grows or
 * URL becomes a conversation URL). Never retries when submission may have
 * gone through (duplicate-prompt protection).
 */
export async function submitPrompt(page: Page, message: string, timeoutMs: number): Promise<SubmitOutcome> {
  const composer = composerLocator(page)
  if (!(await composer.isVisible())) {
    throw new CodedError("Prompt composer not found on the page.", "BROWSER_COMPOSER_MISSING")
  }
  const beforeAssistant = await assistantCount(page)
  const beforeUrl = page.url()

  await composer.click()
  await composer.fill(message)

  const sendButton = page.locator(SELECTORS.sendButton).first()
  let clicked = false
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
