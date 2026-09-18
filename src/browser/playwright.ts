import { chromium, type BrowserContext, type Page } from "playwright-core"
import { join } from "node:path"
import type {
  AuthStatus,
  ChatBackend,
  Conversation,
  ProjectStatus,
  SendResult,
} from "./backend.js"
import { CONVERSATION_UNRESUMABLE, CodedError } from "./backend.js"
import { Mutex } from "../util/mutex.js"
import { log } from "../util/log.js"
import { SELECTORS, CHATGPT_URL, LOGIN_SIGNALS } from "./selectors.js"
import { discoverBrowser } from "./launch.js"
import { browserProfileDir } from "../state/paths.js"
import { ensureDir } from "../state/atomic-store.js"
import { projectIdFromUrl } from "../state/workspaces.js"
import {
  awaitResponseCompletion,
  captureFailureScreenshot,
  composerLocator,
  conversationIdFromUrl,
  isComposerVisible,
  submitPrompt,
} from "./completion.js"

export interface PlaywrightBackendOptions {
  headless?: boolean
  executablePath?: string
  channel?: string
  profileDir?: string
  navigationTimeoutMs?: number
  screenshotsDir?: string
  stabilityPolls?: number
}

const LOGIN_POLL_MS = 2_000
const LOGIN_MAX_MS = 10 * 60_000

export class PlaywrightChatBackend implements ChatBackend {
  readonly name = "playwright"
  readonly queue = new Mutex()
  private context: BrowserContext | null = null
  private page: Page | null = null
  private opts: PlaywrightBackendOptions

  constructor(opts: PlaywrightBackendOptions = {}) {
    this.opts = opts
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page
    await this.launch()
    if (!this.page) throw new CodedError("Browser page unavailable after launch.", "BROWSER_FAILURE")
    return this.page
  }

  private async launch(): Promise<void> {
    if (this.context) return
    const profileDir = this.opts.profileDir ?? browserProfileDir()
    await ensureDir(profileDir)
    const discovered = await discoverBrowser({
      browserExecutable: this.opts.executablePath,
      browserChannel: this.opts.channel,
    })
    const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.opts.headless ?? false,
      viewport: { width: 1440, height: 900 },
      args: [],
      // macOS: Playwright's default --use-mock-keychain makes Chromium
      // encrypt cookies with a mock key, so sessions created in a normally
      // launched browser (real Keychain) are unreadable here and vice versa.
      // Use the real keychain so the dedicated profile is interoperable.
      ignoreDefaultArgs: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
    }
    if (discovered.executablePath) launchOpts.executablePath = discovered.executablePath
    else if (discovered.channel) launchOpts.channel = discovered.channel as never
    log.info("launching browser", {
      profile: profileDir,
      executable: discovered.executablePath ?? discovered.channel ?? "bundled",
      headless: launchOpts.headless,
    })
    this.context = await chromium.launchPersistentContext(profileDir, launchOpts)
    this.page = this.context.pages()[0] ?? (await this.context.newPage())
    this.page.setDefaultTimeout(this.opts.navigationTimeoutMs ?? 60_000)
  }

  async close(): Promise<void> {
    await this.queue.run(async () => {
      try {
        await this.context?.close()
      } catch {
        /* already closed */
      }
      this.context = null
      this.page = null
    })
  }

  private async navigate(url: string): Promise<Page> {
    const page = await this.ensurePage()
    if (page.url() === url) return page // already there; avoid reload
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.opts.navigationTimeoutMs ?? 60_000 })
    } catch (e) {
      await this.screenshot(page, "navigation-failed")
      throw new CodedError(`Navigation to ${url} failed: ${(e as Error).message}`, "BROWSER_NAVIGATION_FAILED")
    }
    return page
  }

  private async hasLoginCta(page: Page): Promise<boolean> {
    // Check several candidates and ALL matches — .first() can be a hidden
    // element, which previously caused a false "authenticated" verdict.
    const candidates = [
      LOGIN_SIGNALS.loginLink,
      LOGIN_SIGNALS.loginButton,
      'button:has-text("Log in")',
      'a:has-text("Log in")',
      '[data-testid="login-button"]',
    ]
    for (const sel of candidates) {
      try {
        const matches = page.locator(sel)
        const n = await matches.count()
        for (let i = 0; i < Math.min(n, 8); i++) {
          if (await matches.nth(i).isVisible({ timeout: 250 })) return true
        }
      } catch {
        /* selector not present */
      }
    }
    return false
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.queue.run(async () => {
        await this.ensurePage()
      })
      return { ok: true, detail: "browser context alive" }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  async verifyAuth(): Promise<AuthStatus> {
    return this.queue.run(async () => {
      const page = await this.navigate(CHATGPT_URL)
      const composer = await isComposerVisible(page, 20_000)
      const loginCta = await this.hasLoginCta(page)
      if (composer && !loginCta) {
        return { authenticated: true, detail: "prompt composer visible, no login CTA" }
      }
      return {
        authenticated: false,
        detail: loginCta
          ? "login call-to-action present"
          : composer
            ? "composer visible but login call-to-action present"
            : "prompt composer not visible (login page or challenge)",
      }
    })
  }

  /** `cgpt login` only: wait for the user to log in in the visible window. */
  async waitForInteractiveLogin(timeoutMs = LOGIN_MAX_MS): Promise<AuthStatus> {
    return this.queue.run(async () => {
      const page = await this.navigate(CHATGPT_URL)
      const deadline = Date.now() + timeoutMs
      log.info("waiting for interactive login in the visible browser window…")
      while (Date.now() < deadline) {
        const composer = await isComposerVisible(page, 2_000)
        const loginCta = await this.hasLoginCta(page)
        if (composer && !loginCta) {
          return { authenticated: true, detail: "login completed and verified" }
        }
        await page.waitForTimeout(LOGIN_POLL_MS)
      }
      return { authenticated: false, detail: "login not completed within the allotted time" }
    })
  }

  async verifyProject(projectUrl: string): Promise<ProjectStatus> {
    return this.queue.run(async () => this.verifyProjectOnPage(projectUrl))
  }

  private async verifyProjectOnPage(projectUrl: string): Promise<ProjectStatus> {
    const page = await this.navigate(projectUrl)
    if (await this.hasLoginCta(page)) {
      return { ok: false, projectId: null, detail: "not authenticated; login call-to-action shown" }
    }
    if (!(await isComposerVisible(page, 20_000))) {
      await this.screenshot(page, "project-verify")
      return { ok: false, projectId: null, detail: "Project page loaded but prompt composer not found" }
    }
    const liveUrl = page.url()
    const liveId = projectIdFromUrl(liveUrl)
    const boundId = projectIdFromUrl(projectUrl)
    const projectId = liveId ?? boundId
    if (!projectId) {
      return { ok: false, projectId: null, detail: `could not establish project identity from ${liveUrl}` }
    }
    if (!liveUrl.includes(projectId) && !projectUrl.includes(projectId)) {
      return { ok: false, projectId: null, detail: `page ${liveUrl} does not reference project ${projectId}` }
    }
    return { ok: true, projectId, detail: `project page verified at ${liveUrl}` }
  }

  async resumeConversation(conversationUrl: string, projectUrl: string): Promise<ProjectStatus> {
    return this.queue.run(async () => this.resumeInner(conversationUrl, projectUrl))
  }

  /** Must be called from within the queue. */
  private async resumeInner(conversationUrl: string, projectUrl: string): Promise<ProjectStatus> {
    const page = await this.navigate(conversationUrl)
    if (await this.hasLoginCta(page)) {
      return { ok: false, projectId: null, detail: "not authenticated" }
    }
    if (!(await isComposerVisible(page, 20_000))) {
      await this.screenshot(page, "resume-conversation")
      return { ok: false, projectId: null, detail: `conversation not reachable at ${page.url()}` }
    }
    const membership = await this.checkMembership(page, projectUrl)
    if (!membership.ok) await this.screenshot(page, "membership-failed")
    return membership
  }

  private async checkMembership(page: Page, projectUrl: string): Promise<ProjectStatus> {
    const liveUrl = page.url()
    const convProject = projectIdFromUrl(liveUrl)
    const boundProject = projectIdFromUrl(projectUrl)
    if (boundProject && convProject && convProject === boundProject) {
      return { ok: true, projectId: convProject, detail: "membership verified via conversation URL" }
    }
    if (boundProject) {
      const link = await page
        .locator(`a[href*="${boundProject}"]`)
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
      if (link) {
        return { ok: true, projectId: boundProject, detail: "membership verified via project link on page" }
      }
    }
    return {
      ok: false,
      projectId: null,
      detail: `cannot prove conversation ${liveUrl} belongs to project ${projectUrl}`,
    }
  }

  async startConversation(
    projectUrl: string,
    message: string,
    timeoutMs: number,
  ): Promise<{ conversation: Conversation; result: SendResult }> {
    return this.queue.run(async () => {
      const verify = await this.verifyProjectOnPage(projectUrl)
      if (!verify.ok) {
        throw new CodedError(
          `Configured ChatGPT Project could not be verified. No prompt was submitted. Detail: ${verify.detail}`,
          "BROWSER_PROJECT_MISSING",
        )
      }
      // Starting a chat from the project page creates a NEW conversation
      // inside the project.
      const page = await this.ensurePage()
      if (!(await isComposerVisible(page, 20_000))) {
        await this.screenshot(page, "create-conversation")
        throw new CodedError(
          `Could not open the bound Project (composer missing) at ${projectUrl}.`,
          "BROWSER_PROJECT_MISSING",
        )
      }
      const submit = await submitPrompt(page, message, 30_000)
      const completion = await awaitResponseCompletion(page, submit.beforeAssistant, timeoutMs, this.opts.stabilityPolls ?? 2)
      const conversationUrl = page.url()
      return {
        conversation: { url: conversationUrl, id: conversationIdFromUrl(conversationUrl) },
        result: { text: completion.text, conversationUrl },
      }
    })
  }

  async continueConversation(
    conversationUrl: string,
    projectUrl: string,
    message: string,
    timeoutMs: number,
  ): Promise<SendResult> {
    return this.queue.run(async () => {
      const resume = await this.resumeInner(conversationUrl, projectUrl)
      if (!resume.ok) {
        throw new CodedError(
          `Stored conversation could not be resumed with verified project membership. Detail: ${resume.detail}`,
          CONVERSATION_UNRESUMABLE,
        )
      }
      const page = await this.ensurePage()
      const submit = await submitPrompt(page, message, 30_000)
      const completion = await awaitResponseCompletion(page, submit.beforeAssistant, timeoutMs, this.opts.stabilityPolls ?? 2)
      return { text: completion.text, conversationUrl: page.url() }
    })
  }

  /** Diagnostic helper: fill the composer without sending (doctor dry-run). */
  async composerPresent(): Promise<boolean> {
    return this.queue.run(async () => {
      const page = await this.ensurePage()
      try {
        return await composerLocator(page).isVisible({ timeout: 5_000 })
      } catch {
        return false
      }
    })
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.run(fn)
  }

  private async screenshot(page: Page, tag: string): Promise<void> {
    if (!this.opts.screenshotsDir) return
    const path = join(this.opts.screenshotsDir, `${tag}-${Date.now()}.png`)
    await captureFailureScreenshot(page, path)
  }
}
