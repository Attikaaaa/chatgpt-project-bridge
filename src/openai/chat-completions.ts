import type { ValidatedToolCall } from "../chatgpt/protocol.js"
import { randomId } from "../util/crypto.js"

export interface ToolCallAccumulator {
  index: number
  id: string
  name: string
  arguments: string
}

export function buildToolCallsResponse(params: {
  model: string
  calls: ValidatedToolCall[]
  created?: number
  id?: string
}): Record<string, unknown> {
  const id = params.id ?? randomId("chatcmpl")
  return {
    id,
    object: "chat.completion",
    created: params.created ?? Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: params.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  }
}

export function buildFinalResponse(params: {
  model: string
  content: string
  created?: number
  id?: string
}): Record<string, unknown> {
  const id = params.id ?? randomId("chatcmpl")
  return {
    id,
    object: "chat.completion",
    created: params.created ?? Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: params.content },
        finish_reason: "stop",
      },
    ],
  }
}

/**
 * Buffered SSE emission: split content into word-ish chunks to exercise
 * client streaming paths, then one tool-call delta sequence or finish chunk.
 * Semantics are OpenAI-compatible; timing is buffered (V1 tradeoff).
 */
export function buildSseChunks(params: {
  id: string
  model: string
  created: number
  content: string | null
  toolCalls?: ValidatedToolCall[]
  finishReason: "stop" | "tool_calls"
  includeUsage?: boolean
}): string[] {
  const { id, model, created } = params
  const base = { id, object: "chat.completion.chunk", created, model }
  const chunks: string[] = []

  const frame = (delta: Record<string, unknown>, finishReason: string | null) => {
    return `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`
  }

  chunks.push(frame({ role: "assistant", content: "" }, null))

  if (params.content !== null && params.content.length > 0) {
    // split on whitespace boundaries to keep words intact
    const pieces = params.content.match(/\S+\s*/g) ?? [params.content]
    for (const piece of pieces) {
      chunks.push(frame({ content: piece }, null))
    }
  }

  if (params.toolCalls) {
    params.toolCalls.forEach((c, index) => {
      chunks.push(
        frame(
          {
            tool_calls: [
              {
                index,
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              },
            ],
          },
          null,
        ),
      )
    })
  }

  chunks.push(frame({}, params.finishReason))
  if (params.includeUsage) {
    // Token accounting is not measurable through the web UI; usage is
    // intentionally reported as null rather than fabricated.
    chunks.push(
      `data: ${JSON.stringify({ ...base, choices: [], usage: null })}\n\n`,
    )
  }
  chunks.push("data: [DONE]\n\n")
  return chunks
}
