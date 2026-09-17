import type { Mutex } from "../util/mutex.js"

export interface AuthStatus {
  authenticated: boolean
  detail: string
}

export interface ProjectStatus {
  ok: boolean
  projectId: string | null
  detail: string
}

export interface Conversation {
  url: string
  id: string | null
}

export interface SendResult {
  text: string
  conversationUrl: string
}

/**
 * Abstraction over "the ChatGPT backend" so deterministic tests can use a
 * fake implementation while real proof uses Playwright.
 *
 * Contract: it is IMPOSSIBLE to send a message without first being on (and
 * verifying) the correct conversation:
 *  - startConversation: open project → verify → new conversation → send
 *  - continueConversation: verify stored conversation + project membership → send
 * Both are atomic under the backend queue; no interleaving.
 */
export interface ChatBackend {
  readonly name: string
  health(): Promise<{ ok: boolean; detail: string }>
  verifyAuth(): Promise<AuthStatus>
  verifyProject(projectUrl: string): Promise<ProjectStatus>
  /** Verify an existing conversation is reachable and belongs to the project. */
  resumeConversation(conversationUrl: string, projectUrl: string): Promise<ProjectStatus>
  /** Open the project, verify it, create a NEW conversation, send, await response. */
  startConversation(
    projectUrl: string,
    message: string,
    timeoutMs: number,
  ): Promise<{ conversation: Conversation; result: SendResult }>
  /**
   * Ensure the browser is on the stored conversation AND that it provably
   * belongs to projectUrl, then send and await the response.
   * Throws CodedError(code: "CONVERSATION_UNRESUMABLE") when membership or
   * reachability cannot be proven — never silently sends elsewhere.
   */
  continueConversation(
    conversationUrl: string,
    projectUrl: string,
    message: string,
    timeoutMs: number,
  ): Promise<SendResult>
  /** Serialize a whole turn against other turns. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  readonly queue: Mutex
  close(): Promise<void>
}

export class CodedError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = "CodedError"
  }
}

export const CONVERSATION_UNRESUMABLE = "CONVERSATION_UNRESUMABLE"
