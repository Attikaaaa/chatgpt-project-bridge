/**
 * Selector strategy: primary test-ids (upstream-audited, see
 * docs/upstream-audit.md) with semantic fallbacks. Two UI variants exist:
 *  - authenticated: data-testid="prompt-textarea", send-button, stop-button,
 *    data-message-author-role attributes
 *  - anonymous/limited: textarea#mobile-composer-prompt ("Ask ChatGPT"),
 *    button[aria-label="Send message"]
 * No generated class names, no nth-child, no DOM-depth assumptions.
 */
export const SELECTORS = {
  promptComposer: [
    '[data-testid="prompt-textarea"]',
    "#prompt-textarea",
    "#mobile-composer-prompt",
    'div[contenteditable="true"]',
    'textarea[aria-label*="Chat"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Ask"]',
  ].join(", "),
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label*="Send"]',
  ].join(", "),
  stopButton: [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
  ].join(", "),
  assistantMessages: '[data-message-author-role="assistant"], li[data-message-role="assistant"]',
  userMessages: '[data-message-author-role="user"], li[data-message-role="user"]',
  /** Fallback turn containers when role attributes are absent. */
  conversationTurns: '[data-testid^="conversation-turn"]',
  /** Anonymous/octane UI: assistant message completion attribute. */
  messageComplete: '[data-message-complete]',
} as const

export const CHATGPT_URL = "https://chatgpt.com/"

/** Login call-to-action signals (upstream-audited concept). */
export const LOGIN_SIGNALS = {
  loginLink: 'a[href*="auth/login"], a[href*="/auth/login"]',
  loginButton:
    'button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign up for free"), a:has-text("Sign up for free")',
} as const
