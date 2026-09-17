import { describe, it, expect } from "vitest"
import {
  ChatCompletionRequestSchema,
  messageFingerprint,
  stableStringify,
  MODEL_ID,
} from "../../src/openai/schemas.js"
import { buildFinalResponse, buildToolCallsResponse, buildSseChunks } from "../../src/openai/chat-completions.js"

describe("chat completion request schema", () => {
  it("accepts a realistic OpenCode-shaped request", () => {
    const req = {
      model: MODEL_ID,
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file contents" },
      ],
      tools: [
        { type: "function", function: { name: "read", description: "r", parameters: { type: "object" } } },
      ],
      tool_choice: "auto",
      stream: true,
    }
    const parsed = ChatCompletionRequestSchema.safeParse(req)
    expect(parsed.success).toBe(true)
  })
  it("rejects empty messages and missing model", () => {
    expect(ChatCompletionRequestSchema.safeParse({ messages: [] }).success).toBe(false)
    expect(ChatCompletionRequestSchema.safeParse({ model: "x", messages: "no" }).success).toBe(false)
  })
})

describe("response construction", () => {
  it("tool_calls response", () => {
    const r = buildToolCallsResponse({
      model: MODEL_ID,
      calls: [{ id: "call_1", name: "read", arguments: { path: "a" } }],
    })
    expect((r.choices as any)[0].finish_reason).toBe("tool_calls")
    expect((r.choices as any)[0].message.tool_calls[0].function.arguments).toBe('{"path":"a"}')
  })
  it("final response", () => {
    const r = buildFinalResponse({ model: MODEL_ID, content: "done" })
    expect((r.choices as any)[0].finish_reason).toBe("stop")
    expect((r.choices as any)[0].message.content).toBe("done")
  })
  it("SSE chunk sequence is well-formed", () => {
    const chunks = buildSseChunks({
      id: "c1",
      model: MODEL_ID,
      created: 1,
      content: "hello world",
      finishReason: "stop",
    })
    expect(chunks[0]).toMatch(/^data: /)
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n")
    const first = JSON.parse(chunks[0].slice(6))
    expect(first.choices[0].delta.role).toBe("assistant")
    const mid = JSON.parse(chunks[1].slice(6))
    expect(mid.choices[0].delta.content).toContain("hello")
  })
  it("SSE tool_calls sequence", () => {
    const chunks = buildSseChunks({
      id: "c1",
      model: MODEL_ID,
      created: 1,
      content: null,
      toolCalls: [{ id: "call_9", name: "bash", arguments: { cmd: "ls" } }],
      finishReason: "tool_calls",
    })
    const toolChunk = JSON.parse(chunks[1].slice(6))
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("bash")
    expect(toolChunk.choices[0].delta.tool_calls[0].id).toBe("call_9")
  })
})

describe("fingerprints", () => {
  it("stable stringify is order-independent", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
  })
  it("message fingerprint distinguishes roles/content", () => {
    expect(messageFingerprint({ role: "user", content: "a" })).not.toBe(messageFingerprint({ role: "user", content: "b" }))
    expect(messageFingerprint({ role: "user", content: "a" })).toBe(messageFingerprint({ role: "user", content: "a" }))
  })
})
