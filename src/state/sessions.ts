import { join } from "node:path"
import { createHash } from "node:crypto"
import { sessionsDir } from "./paths.js"
import { atomicWriteJson, readJson, removeQuietly } from "./atomic-store.js"
import type { ChatMessage } from "../openai/schemas.js"
import { messageFingerprint } from "../openai/schemas.js"

export interface ConversationRef {
  /** Absolute conversation URL (or provider-specific reference). */
  url: string
  /** Conversation id if extractable. */
  id: string | null
  /** Project URL this conversation belongs to. */
  projectUrl: string
}

export interface SessionRecord {
  key: string
  workspaceDir: string
  sessionId: string
  projectUrl: string
  conversation: ConversationRef
  /** Fingerprints of OpenCode messages already present in the conversation. */
  ledger: string[]
  /** Hash of system messages last sent. */
  systemHash: string | null
  /** Hash of tool manifest last sent. */
  toolsHash: string | null
  /** Fingerprints of assistant messages this bridge produced. */
  producedResponses: string[]
  createdAt: string
  updatedAt: string
}

export function sessionKey(workspaceDir: string, sessionId: string): string {
  return `${workspaceDir}::${sessionId}`
}

function fileNameForKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32) + ".json"
}

export async function loadSession(key: string): Promise<SessionRecord | null> {
  return readJson<SessionRecord | null>(join(sessionsDir(), fileNameForKey(key)), null)
}

export async function saveSession(record: SessionRecord): Promise<void> {
  record.updatedAt = new Date().toISOString()
  await atomicWriteJson(join(sessionsDir(), fileNameForKey(record.key)), record)
}

export async function deleteSession(key: string): Promise<boolean> {
  const exists = (await loadSession(key)) !== null
  if (exists) await removeQuietly(join(sessionsDir(), fileNameForKey(key)))
  return exists
}

export function extendLedger(record: SessionRecord, messages: ChatMessage[], fromIndex: number): void {
  for (let i = fromIndex; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    record.ledger.push(messageFingerprint(m))
  }
}

export function recordProduced(record: SessionRecord, assistantMessage: unknown): void {
  record.producedResponses.push(messageFingerprint(assistantMessage as ChatMessage))
  if (record.producedResponses.length > 200) record.producedResponses.shift()
}

export function newSessionRecord(params: {
  workspaceDir: string
  sessionId: string
  projectUrl: string
  conversation: ConversationRef
}): SessionRecord {
  const now = new Date().toISOString()
  return {
    key: sessionKey(params.workspaceDir, params.sessionId),
    workspaceDir: params.workspaceDir,
    sessionId: params.sessionId,
    projectUrl: params.projectUrl,
    conversation: params.conversation,
    ledger: [],
    systemHash: null,
    toolsHash: null,
    producedResponses: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** Deterministic resync: same record shape, fresh conversation. */
export function resetConversation(record: SessionRecord, conversation: ConversationRef): void {
  record.conversation = conversation
  record.ledger = []
  record.systemHash = null
  record.toolsHash = null
}
