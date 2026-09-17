import { createHash } from "node:crypto"
import { z } from "zod"

/** OpenAI chat message subset actually used by OpenCode + AI SDK. */
export const ToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
})

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
}).passthrough()

export const ToolDefinitionSchema = z.object({
  type: z.literal("function").default("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.any()).optional(),
  }).passthrough(),
}).passthrough()

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  tools: z.array(ToolDefinitionSchema).optional(),
  tool_choice: z.any().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  stream_options: z.any().optional(),
}).passthrough()

export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ToolCall = z.infer<typeof ToolCallSchema>
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>

/** The single generic model the bridge exposes. */
export const MODEL_ID = "chatgpt-project-web"
export const PROVIDER_ID = "cgpt-project"

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex")
}

/** Deterministic JSON serialization (sorted object keys). */
export function stableStringify(value: unknown): string {
  const seen = new Set<unknown>()
  const encode = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`
    if (seen.has(v)) return '"[circular]"'
    seen.add(v)
    const obj = v as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`).join(",")}}`
  }
  return encode(value)
}

/** Serialize a message for fingerprinting (stable subset). */
export function messageFingerprint(m: ChatMessage): string {
  return fingerprint({
    role: m.role,
    content: typeof m.content === "string" ? m.content : m.content ?? null,
    tool_calls: m.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    tool_call_id: m.tool_call_id,
    name: m.name,
  })
}
