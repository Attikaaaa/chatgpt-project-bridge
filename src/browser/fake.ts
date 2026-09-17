import { randomUUID } from "node:crypto"
import type {
  AuthStatus,
  ChatBackend,
  Conversation,
  ProjectStatus,
  SendResult,
} from "./backend.js"
import { CONVERSATION_UNRESUMABLE, CodedError } from "./backend.js"
import { Mutex } from "../util/mutex.js"

export interface FakeConversation {
  id: string
  url: string
  projectUrl: string
  transcript: Array<{ role: "user" | "assistant"; text: string }>
}

export interface FakeScriptStep {
  /** Match on the incoming message content; undefined = catch-all. */
  match?: string | RegExp
  /** Response text (a transport JSON object in normal use). */
  respond: string
}

/**
 * Deterministic ChatBackend for tests. Scripted responses are matched in
 * order; the last script step repeats. Records all sends for assertions.
 * The most recently created conversation is the active one, mirroring
 * "browser focus".
 */
export class FakeChatBackend implements ChatBackend {
  readonly name = "fake"
  readonly queue = new Mutex()
  conversations = new Map<string, FakeConversation>()
  sends: Array<{ conversationId: string; message: string; at: number }> = []
  starts: Array<{ projectUrl: string; at: number }> = []
  closed = false
  authenticated = true
  projectFailure: string | null = null
  sendFailure: string | null = null
  private script: FakeScriptStep[]
  private scriptIndex = 0
  private activeId: string | null = null

  constructor(script: FakeScriptStep[] = []) {
    this.script = script
  }

  private responseFor(message: string): string {
    const step = this.script[this.scriptIndex]
    if (step && (step.match === undefined || matches(message, step.match))) {
      this.scriptIndex = Math.min(this.scriptIndex + 1, this.script.length - 1)
      return step.respond
    }
    const last = this.script[this.script.length - 1]
    return last?.respond ?? '{"type":"final","content":"ok"}'
  }

  async health() {
    return this.closed ? { ok: false, detail: "fake backend closed" } : { ok: true, detail: "fake" }
  }

  async verifyAuth(): Promise<AuthStatus> {
    if (this.closed) throw new Error("fake backend closed")
    return { authenticated: this.authenticated, detail: this.authenticated ? "fake-auth" : "fake: not logged in" }
  }

  async verifyProject(projectUrl: string): Promise<ProjectStatus> {
    if (this.closed) throw new Error("fake backend closed")
    if (this.projectFailure) return { ok: false, projectId: null, detail: this.projectFailure }
    return { ok: true, projectId: projectIdFromUrl(projectUrl), detail: "fake project verified" }
  }

  async resumeConversation(conversationUrl: string, projectUrl: string): Promise<ProjectStatus> {
    if (this.closed) throw new Error("fake backend closed")
    const id = conversationUrl.match(/c\/([^/?#]+)/)?.[1]
    const conv = id ? this.conversations.get(id) : undefined
    if (!conv) return { ok: false, projectId: null, detail: `conversation not found: ${conversationUrl}` }
    if (conv.projectUrl !== projectUrl) {
      return { ok: false, projectId: null, detail: "conversation does not belong to the bound project" }
    }
    return { ok: true, projectId: projectIdFromUrl(projectUrl), detail: "fake resumed" }
  }

  async startConversation(
    projectUrl: string,
    message: string,
    _timeoutMs: number,
  ): Promise<{ conversation: Conversation; result: SendResult }> {
    if (this.closed) throw new Error("fake backend closed")
    if (this.projectFailure) {
      throw new CodedError(
        `Configured ChatGPT Project could not be verified. No prompt was submitted. Detail: ${this.projectFailure}`,
        "BROWSER_PROJECT_MISSING",
      )
    }
    if (this.sendFailure) throw new CodedError(this.sendFailure, "BROWSER_SEND_FAILED")
    const id = randomUUID()
    const conv: FakeConversation = {
      id,
      url: `https://chatgpt.com/fake/c/${id}`,
      projectUrl,
      transcript: [],
    }
    this.conversations.set(id, conv)
    this.starts.push({ projectUrl, at: Date.now() })
    this.activeId = id
    this.sends.push({ conversationId: id, message, at: Date.now() })
    conv.transcript.push({ role: "user", text: message })
    const response = this.responseFor(message)
    conv.transcript.push({ role: "assistant", text: response })
    return { conversation: { url: conv.url, id }, result: { text: response, conversationUrl: conv.url } }
  }

  async continueConversation(
    conversationUrl: string,
    projectUrl: string,
    message: string,
    _timeoutMs: number,
  ): Promise<SendResult> {
    if (this.closed) throw new Error("fake backend closed")
    if (this.sendFailure) throw new CodedError(this.sendFailure, "BROWSER_SEND_FAILED")
    const id = conversationUrl.match(/c\/([^/?#]+)/)?.[1]
    const conv = id ? this.conversations.get(id) : undefined
    if (!conv) {
      throw new CodedError(`conversation not found: ${conversationUrl}`, CONVERSATION_UNRESUMABLE)
    }
    if (conv.projectUrl !== projectUrl) {
      throw new CodedError(
        `conversation does not belong to the bound project`,
        CONVERSATION_UNRESUMABLE,
      )
    }
    this.activeId = conv.id
    this.sends.push({ conversationId: conv.id, message, at: Date.now() })
    conv.transcript.push({ role: "user", text: message })
    const response = this.responseFor(message)
    conv.transcript.push({ role: "assistant", text: response })
    return { text: response, conversationUrl: conv.url }
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.run(fn)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  reset() {
    this.conversations.clear()
    this.sends = []
    this.starts = []
    this.scriptIndex = 0
    this.activeId = null
  }
}

function matches(message: string, m: string | RegExp): boolean {
  return typeof m === "string" ? message.includes(m) : m.test(message)
}

function projectIdFromUrl(url: string): string | null {
  return url.match(/g-p-[A-Za-z0-9-]+/)?.[0] ?? null
}
