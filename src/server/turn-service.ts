import { CgptError, Codes } from "../util/errors.js"
import { log } from "../util/log.js"
import { Mutex } from "../util/mutex.js"
import { CONVERSATION_UNRESUMABLE, type ChatBackend, type CodedError } from "../browser/backend.js"
import type { ToolManifestEntry } from "../chatgpt/protocol.js"
import { parseTransportResponse, protocolFailure } from "../chatgpt/protocol.js"
import {
  RESPOND_NOW,
  REPAIR_PROMPT,
  TRANSPORT_PROMPT,
  renderAssistantMessage,
  renderSystemContext,
  renderToolManifest,
  renderToolResults,
  renderUserMessage,
} from "../chatgpt/transport.js"
import type { ChatMessage, ToolDefinition } from "../openai/schemas.js"
import { fingerprint, messageFingerprint } from "../openai/schemas.js"
import { canonicalWorkspace, getBinding } from "../state/workspaces.js"
import {
  extendLedger,
  loadSession,
  newSessionRecord,
  recordProduced,
  resetConversation,
  saveSession,
  sessionKey,
  type SessionRecord,
} from "../state/sessions.js"
import { buildFinalResponse, buildToolCallsResponse } from "../openai/chat-completions.js"

export interface RequestMetadata {
  sessionId: string | null
  directory: string
  worktree: string | null
}

export interface TurnInput {
  model: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
}

export interface TurnOutput {
  response: Record<string, unknown>
  kind: "tool_calls" | "final"
}

function toManifest(tools: ToolDefinition[]): ToolManifestEntry[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }))
}

export function contentToText(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content
  if (Array.isArray(m.content)) {
    const parts: string[] = []
    for (const p of m.content) {
      if (p && typeof p === "object") {
        const part = p as Record<string, unknown>
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text)
        else parts.push(JSON.stringify(part))
      } else if (typeof p === "string") {
        parts.push(p)
      }
    }
    return parts.join("\n")
  }
  return ""
}

interface SplitHistory {
  systems: string[]
  conversation: ChatMessage[]
}

function splitHistory(messages: ChatMessage[]): SplitHistory {
  const systems: string[] = []
  const conversation: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === "system") systems.push(contentToText(m))
    else conversation.push(m)
  }
  return { systems, conversation }
}

function buildCallNameIndex(messages: ChatMessage[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) index.set(tc.id, tc.function.name)
    }
  }
  return index
}

interface RenderedMessage {
  text: string
  isAssistantFromOtherProvider: boolean
}

function renderMessage(
  m: ChatMessage,
  callNames: Map<string, string>,
  producedHashes: Set<string>,
): RenderedMessage | null {
  if (m.role === "user") return { text: renderUserMessage(contentToText(m)), isAssistantFromOtherProvider: false }
  if (m.role === "tool") {
    return {
      text: renderToolResults([
        {
          id: m.tool_call_id ?? "unknown",
          name: m.tool_call_id ? callNames.get(m.tool_call_id) : undefined,
          content: contentToText(m) || "(empty result)",
          isError: Boolean((m as Record<string, unknown>).is_error),
        },
      ]),
      isAssistantFromOtherProvider: false,
    }
  }
  if (m.role === "assistant") {
    const fp = messageFingerprint(m)
    if (producedHashes.has(fp)) return null // this bridge produced it; ChatGPT already has it
    return { text: renderAssistantMessage(contentToText(m)), isAssistantFromOtherProvider: true }
  }
  return null
}

/** Canonical snapshot of the entire history for resync. */
export function renderFullSnapshot(systems: string[], messages: ChatMessage[], callNames: Map<string, string>): string {
  const chunks: string[] = []
  if (systems.length > 0) chunks.push(renderSystemContext(systems))
  const all: string[] = []
  for (const m of messages) {
    const rendered = renderMessage(m, callNames, new Set()) ?? {
      text:
        m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
          ? `[ASSISTANT (your previous tool calls)]\n${JSON.stringify(
              m.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
            )}`
          : null,
      isAssistantFromOtherProvider: false,
    }
    if (rendered.text) all.push(rendered.text)
  }
  chunks.push(all.join("\n\n"))
  return chunks.join("\n\n")
}

function renderDelta(
  messages: ChatMessage[],
  from: number,
  callNames: Map<string, string>,
  producedHashes: Set<string>,
): string {
  const chunks: string[] = []
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    const rendered = renderMessage(m, callNames, producedHashes)
    if (rendered) chunks.push(rendered.text)
  }
  return chunks.join("\n\n")
}

export class TurnService {
  /** Per-session locks: same-session requests are fully serialized so the
   * session-record check-then-act cannot race. Lock order is always
   * session → backend queue, so no deadlock is possible. */
  private sessionLocks = new Map<string, Mutex>()

  constructor(
    private backend: ChatBackend,
    private responseTimeoutMs = 300_000,
  ) {}

  private withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.sessionLocks.get(key)
    if (!lock) {
      lock = new Mutex()
      this.sessionLocks.set(key, lock)
    }
    return lock.run(fn)
  }

  /**
   * Handle one OpenAI chat-completions request end-to-end.
   * Fail-closed on any identity/routing ambiguity.
   */
  async handle(input: TurnInput, meta: RequestMetadata): Promise<TurnOutput> {
    // 1. Workspace identity is load-bearing: metadata must be present.
    if (!meta.directory) {
      throw new CgptError(
        "Missing OpenCode runtime directory metadata. Install the bridge plugin (cgpt opencode install) or pass the X-CGPT-Directory header.",
        Codes.MissingMetadata,
      )
    }
    const workspaceDir = await canonicalWorkspace(meta.directory)
    const binding = await getBinding(workspaceDir)
    if (!binding) {
      throw new CgptError(
        `No ChatGPT Project is bound to:\n${workspaceDir}\n\nRun:\n  cgpt bind <project-url>\nfrom that directory.`,
        Codes.Unbound,
      )
    }

    // 2. Session key — everything below is serialized per session.
    const sessionId = meta.sessionId ?? `oneshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const key = sessionKey(binding.dir, sessionId)
    return this.withSessionLock(key, () => this.handleLocked(input, meta, binding, sessionId, key))
  }

  private async handleLocked(
    input: TurnInput,
    meta: RequestMetadata,
    binding: { dir: string; entry: { projectUrl: string } },
    sessionId: string,
    key: string,
  ): Promise<TurnOutput> {
    const existing = await loadSession(key)
    const isNew = existing === null

    const { systems, conversation } = splitHistory(input.messages)
    const callNames = buildCallNameIndex(input.messages)
    const manifest = toManifest(input.tools)
    const systemHash = systems.length > 0 ? fingerprint(systems) : null
    const toolsHash = fingerprint(manifest)

    const fingerprints = conversation.map(messageFingerprint)

    // 3. Ledger comparison: prefix-extend or resync.
    const prefixMatch =
      existing !== null &&
      existing.ledger.length <= fingerprints.length &&
      existing.ledger.every((fp, i) => fp === fingerprints[i])
    const needsResync = existing !== null && !prefixMatch

    if (isNew || needsResync) {
      const reason = isNew ? "new-session" : "history-divergence"
      log.info("starting new ChatGPT conversation", { reason, workspace: binding.dir, session: sessionId })
      const auth = await this.backend.verifyAuth()
      if (!auth.authenticated) {
        throw new CgptError(
          "ChatGPT browser profile is not authenticated.\n\nRun:\n  cgpt login",
          Codes.NotLoggedIn,
        )
      }
      const composed = composeMessage({
        bootstrap: true,
        resync: needsResync,
        systems,
        conversation,
        from: 0,
        callNames,
        produced: new Set(existing?.producedResponses ?? []),
        manifest,
        toolsChanged: true,
        systemChanged: true,
      })
      const started = await this.backend.startConversation(binding.entry.projectUrl, composed, this.responseTimeoutMs)
      const record = newSessionRecord({
        workspaceDir: binding.dir,
        sessionId,
        projectUrl: binding.entry.projectUrl,
        conversation: {
          url: started.result.conversationUrl,
          id: started.conversation.id,
          projectUrl: binding.entry.projectUrl,
        },
      })
      if (needsResync) {
        log.warn("history divergence: resynchronized into a new ChatGPT conversation", {
          session: sessionId,
          workspace: binding.dir,
          conversation: started.conversation.id,
        })
      }
      return this.finish(record, started.result, conversation, 0, manifest, systemHash, toolsHash, input.model)
    }

    const record: SessionRecord = existing

    // 4. Existing session: continue the stored conversation.
    const from = record.ledger.length
    const composed = composeMessage({
      bootstrap: false,
      resync: false,
      systems,
      conversation,
      from,
      callNames,
      produced: new Set(record.producedResponses),
      manifest,
      toolsChanged: record.toolsHash !== toolsHash,
      systemChanged: systemHash !== null && record.systemHash !== systemHash,
    })

    let sendResult
    try {
      sendResult = await this.backend.continueConversation(
        record.conversation.url,
        binding.entry.projectUrl,
        composed,
        this.responseTimeoutMs,
      )
    } catch (err) {
      if ((err as CodedError).code === CONVERSATION_UNRESUMABLE) {
        // §12: safely reconstruct a new conversation from current state.
        log.warn("stored conversation unresumable; resyncing into a new conversation", {
          session: sessionId,
          workspace: binding.dir,
          detail: (err as Error).message,
        })
        const composed2 = composeMessage({
          bootstrap: true,
          resync: true,
          systems,
          conversation,
          from: 0,
          callNames,
          produced: new Set(record.producedResponses),
          manifest,
          toolsChanged: true,
          systemChanged: true,
        })
        const started = await this.backend.startConversation(binding.entry.projectUrl, composed2, this.responseTimeoutMs)
        resetConversation(record, {
          url: started.result.conversationUrl,
          id: started.conversation.id,
          projectUrl: binding.entry.projectUrl,
        })
        return this.finish(record, started.result, conversation, 0, manifest, systemHash, toolsHash, input.model)
      }
      throw err
    }
    return this.finish(record, sendResult, conversation, from, manifest, systemHash, toolsHash, input.model)
  }

  /** Validate the ChatGPT response (one repair attempt) and persist state. */
  private async finish(
    record: SessionRecord,
    sendResult: { text: string; conversationUrl: string },
    conversation: ChatMessage[],
    from: number,
    manifest: ToolManifestEntry[],
    systemHash: string | null,
    toolsHash: string,
    model: string,
  ): Promise<TurnOutput> {
    log.body("chatgpt raw response", { text: sendResult.text })
    let parsed = parseTransportResponse(sendResult.text, manifest)
    let finalSend = sendResult
    if (!parsed.ok) {
      log.warn("transport violation; attempting single repair", { error: parsed.parseError })
      const repairMsg = `${REPAIR_PROMPT}\n\n${RESPOND_NOW}`
      finalSend = await this.backend.continueConversation(
        record.conversation.url,
        record.projectUrl,
        repairMsg,
        this.responseTimeoutMs,
      )
      log.body("chatgpt repair response", { text: finalSend.text })
      parsed = parseTransportResponse(finalSend.text, manifest)
      if (!parsed.ok) {
        throw protocolFailure(parsed.parseError)
      }
    }

    const kind = parsed.kind
    let response: Record<string, unknown>
    if (kind === "tool_calls") {
      response = buildToolCallsResponse({ model, calls: parsed.calls })
      recordProduced(record, {
        role: "assistant" as const,
        content: null,
        tool_calls: parsed.calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      })
    } else {
      response = buildFinalResponse({ model, content: parsed.content })
      recordProduced(record, { role: "assistant" as const, content: parsed.content })
    }

    record.conversation.url = finalSend.conversationUrl
    record.conversation.id = finalSend.conversationUrl.match(/c\/([^/?#]+)/)?.[1] ?? record.conversation.id
    extendLedger(record, conversation, from)
    record.systemHash = systemHash
    record.toolsHash = toolsHash
    await saveSession(record)

    log.info("turn complete", {
      kind,
      workspace: record.workspaceDir,
      session: record.sessionId,
      conversation: record.conversation.id,
      tools: parsed.kind === "tool_calls" ? parsed.calls.map((c) => c.name) : undefined,
    })
    return { response, kind }
  }
}

interface ComposeParams {
  bootstrap: boolean
  resync: boolean
  systems: string[]
  conversation: ChatMessage[]
  from: number
  callNames: Map<string, string>
  produced: Set<string>
  manifest: ToolManifestEntry[]
  toolsChanged: boolean
  systemChanged: boolean
}

function composeMessage(p: ComposeParams): string {
  const parts: string[] = []
  if (p.bootstrap) {
    parts.push(TRANSPORT_PROMPT)
    if (p.systems.length > 0) parts.push(renderSystemContext(p.systems))
    if (p.manifest.length > 0) parts.push(renderToolManifest(p.manifest))
    if (p.resync) {
      parts.push(
        `CONTEXT RESYNC: the connected agent's history was compacted or restarted. A canonical snapshot of the conversation so far follows. Treat it as the conversation history.\n\n${renderFullSnapshot(p.systems, p.conversation, p.callNames)}`,
      )
    } else {
      const delta = renderDelta(p.conversation, p.from, p.callNames, p.produced)
      parts.push(delta || renderUserMessage("(session start — awaiting the user's first request)"))
    }
  } else {
    if (p.systemChanged && p.systems.length > 0) {
      parts.push(`SYSTEM CONTEXT UPDATE:\n${renderSystemContext(p.systems)}`)
    }
    if (p.toolsChanged) {
      parts.push(renderToolManifest(p.manifest))
    }
    parts.push(renderDelta(p.conversation, p.from, p.callNames, p.produced))
  }
  parts.push(RESPOND_NOW)
  return parts.join("\n\n")
}
