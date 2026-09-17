# Upstream audit: RPG-478/codex-chatgpt-bridge

Inspected as required before writing any ChatGPT web-automation code in this
repository.

## What was inspected

| Field | Value |
| --- | --- |
| Repository URL | https://github.com/RPG-478/codex-chatgpt-bridge |
| Commit SHA inspected | `49384fc6534b84f0d2167ba5097a87e0a2e16b5a` (latest on `main`, "Clarify README capabilities and roadmap", 2026-06-01) |
| License | MIT (`LICENSE`: "MIT License, Copyright (c) 2026 codex-chatgpt-bridge contributors") |
| Language | TypeScript, `playwright-core` |

Relevant files inspected:

- `src/adapters/playwright.ts` — all ChatGPT web automation
- `src/config.ts` — project URL validation, config storage
- `src/cli.ts`, `src/adapters/manual.ts`, `src/response.ts` — CLI wiring, response validation

## Concepts reused (with attribution where code-adjacent)

1. **Prompt composer selectors** (`src/adapters/playwright.ts`):
   comma-fallback list `[data-testid="prompt-textarea"], #prompt-textarea,
   textarea[placeholder*="Message"], div[contenteditable="true"]`.
   Reused as the primary selector strategy in
   `src/browser/selectors.ts` (our variant adds role-based fallbacks and an
   explicit `first()` discipline).

2. **Send button selectors**: `[data-testid="send-button"]`,
   `button[aria-label*="Send"]`. Reused. We do not reuse the Japanese label
   fallbacks; we add a structural fallback (Enter key on the editor only when
   the send button is absent, mirroring upstream's fallback order).

3. **Generation-in-progress detection**: stop button visible
   (`[data-testid="stop-button"], button[aria-label*="Stop"]`) implies the
   model is still streaming. Reused as one of several completion signals.

4. **Assistant message identification**: messages matched by
   `[data-message-author-role="assistant"]`; the response to a specific
   submission is the element at an index captured *before* submission
   (`nth(beforeCount)`), with a `page.waitForFunction` on the count growing.
   Reused as the core "response identification" concept (our
   `src/browser/completion.ts`).

5. **Login-state detection**: prompt editor visible + no login/signup
   call-to-action links/buttons. Reused in `verifyAuth`.

6. **Project URL validation**: conservative syntax check — hostname must be
   `chatgpt.com`, pathname must identify a project. Reused concept in
   `src/state/workspaces.ts` (we additionally accept `chat.openai.com` and
   `g-p-` style project ids and always pair syntax validation with live
   verification).

7. **Persistent profile + headful launch**:
   `chromium.launchPersistentContext(profileDir, { headless: false })`.
   Reused; we additionally support explicit `executablePath` discovery across
   Chrome/Edge/Brave/Playwright-cached Chromium because this project must not
   assume Chrome is installed.

## Concepts deliberately NOT reused

- **Upstream response schema** (`verdict/summary/risks/sources/next_action`):
  that is a Codex-review-specific contract. We replace it with the
  OpenAI-tool-call transport protocol in `docs/protocol.md`.
- **Text-stability-only completion detection** (3 identical polls): kept as a
  *secondary* signal only; primary signal is the disappearance of the
  generation control (stop button), because text stability alone can produce
  false positives on slow models.
- **Upstream "navigate to project URL and reuse whatever chat is active"**:
  unsafe for our multi-session requirements. We always create a *new*
  conversation per OpenCode session and capture its URL, and we verify
  project membership on resume.
- **`--disable-blink-features=AutomationControlled`**: not copied. If bot
  protection refuses service we surface the real error (no anti-bot
  circumvention).

## Compatibility

MIT license permits reuse with attribution. This file serves as the required
attribution notice. The reused selector strings are short functional
constants; the structural concepts (fallback lists, count-before-submit,
persistent context) are general engineering patterns.
