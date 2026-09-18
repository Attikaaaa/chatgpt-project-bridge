import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ChatCompletionRequestSchema } from "../../src/openai/schemas.js"
import { buildSseChunks, buildFinalResponse, buildToolCallsResponse } from "../../src/openai/chat-completions.js"
import { parseTransportResponse } from "../../src/chatgpt/protocol.js"

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/opencode/request.json"), "utf8"))

/**
 * Regression test against the captured shape of real OpenCode traffic
 * (test/fixtures/opencode/request.json).
 */
describe("real OpenCode request fixture", () => {
  it("fixture sanity", () => {
    expect(fixture.bodyShape.model).toBe("chatgpt-project-web")
    expect(fixture.bodyShape.stream).toBe(true)
    expect(fixture.metadataHeaders.sessionId).toContain("ses_")
    expect(fixture.toolNames).toContain("bash")
    expect(fixture.toolNames).toContain("read")
    expect(fixture.toolNames).toContain("apply_patch")
  })

  it("schema accepts a request reconstructed from the fixture shape", () => {
    const req = {
      model: fixture.bodyShape.model,
      stream: fixture.bodyShape.stream,
      messages: [
        { role: "system", content: fixture.systemMessageSamplePrefix },
        { role: "user", content: "do the thing" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: fixture.firstToolSample.name,
            description: "Apply a patch",
            parameters: fixture.firstToolSample.parameters,
          },
        },
        ...fixture.toolNames
          .filter((n) => n !== fixture.firstToolSample.name)
          .map((n) => ({
            type: "function",
            function: { name: n, description: `tool ${n}`, parameters: { type: "object", properties: {} } },
          })),
      ],
      tool_choice: fixture.bodyShape.toolChoice,
    }
    const parsed = ChatCompletionRequestSchema.safeParse(req)
    expect(parsed.success).toBe(true)
  })

  it("AJV validates arguments against the captured apply_patch schema", () => {
    const manifest = [
      { name: "apply_patch", description: "", parameters: fixture.firstToolSample.parameters },
    ]
    const good = parseTransportResponse(
      '{"type":"tool_calls","calls":[{"id":"1","name":"apply_patch","arguments":{"patchText":"*** Begin Patch"}}]}',
      manifest,
    )
    expect(good.ok).toBe(true)
    const bad = parseTransportResponse(
      '{"type":"tool_calls","calls":[{"id":"1","name":"apply_patch","arguments":{"wrong":true}}]}',
      manifest,
    )
    expect(bad.ok).toBe(false)
  })

  it("streaming frames satisfy the AI SDK SSE expectations", () => {
    const chunks = buildSseChunks({
      id: "x",
      model: fixture.bodyShape.model,
      created: 1,
      content: "pong",
      finishReason: "stop",
      includeUsage: true,
    })
    for (const c of chunks.filter((c) => c.startsWith("data: ") && !c.includes("[DONE]"))) {
      const json = JSON.parse(c.slice(6))
      expect(json.object).toBe("chat.completion.chunk")
      expect(Array.isArray(json.choices)).toBe(true)
    }
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n")
  })

  it("non-stream fallback responses carry no fabricated usage", () => {
    const final = buildFinalResponse({ model: fixture.bodyShape.model, content: "x" })
    expect(final.usage).toBeUndefined()
    const tools = buildToolCallsResponse({ model: fixture.bodyShape.model, calls: [{ id: "1", name: "bash", arguments: { command: "ls" } }] })
    expect(tools.usage).toBeUndefined()
  })
})
