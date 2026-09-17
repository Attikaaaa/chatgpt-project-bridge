import { Ajv, type ValidateFunction } from "ajv"
import { z } from "zod"
import { CgptError, Codes } from "../util/errors.js"

/**
 * The only two top-level transport responses ChatGPT may produce.
 */
export const TransportResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_calls"),
    calls: z
      .array(
        z.object({
          id: z.string().min(1).optional(),
          name: z.string().min(1),
          arguments: z.unknown(),
        }),
      )
      .min(1),
  }),
  z.object({
    type: z.literal("final"),
    content: z.string(),
  }),
])

export type TransportResponse = z.infer<typeof TransportResponseSchema>

export interface ValidatedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolManifestEntry {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

const ajv = new Ajv({ strict: false, allowUnionTypes: true })

const validatorCache = new Map<string, ValidateFunction>()

function validatorFor(toolName: string, schema: Record<string, unknown> | undefined): ValidateFunction | null {
  if (!schema || typeof schema !== "object") return null
  const key = `${toolName}:${JSON.stringify(schema)}`
  const cached = validatorCache.get(key)
  if (cached) return cached
  try {
    const validate = ajv.compile(schema)
    validatorCache.set(key, validate)
    return validate
  } catch {
    // Uncompilable schema: treat as no schema (arguments still JSON-checked).
    return null
  }
}

/**
 * Extract the first balanced JSON object from arbitrary text.
 * Tolerates markdown fences and surrounding prose.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export type ParseResult =
  | { ok: true; kind: "tool_calls"; calls: ValidatedToolCall[] }
  | { ok: true; kind: "final"; content: string }
  | { ok: false; parseError: string }

/**
 * Parse and validate a ChatGPT response into the transport protocol.
 * Throws nothing; returns a diagnostic on failure so the caller can decide
 * whether to attempt repair.
 */
export function parseTransportResponse(
  rawText: string,
  manifest: ToolManifestEntry[],
  opts: { strictSchemas?: boolean } = {},
): ParseResult {
  const jsonStr = extractJsonObject(rawText)
  if (!jsonStr) {
    return { ok: false, parseError: "No JSON object found in the response." }
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonStr)
  } catch (e) {
    return { ok: false, parseError: `Response JSON is not parseable: ${(e as Error).message}` }
  }

  const shape = TransportResponseSchema.safeParse(parsedJson)
  if (!shape.success) {
    return { ok: false, parseError: `Response does not match the transport schema: ${shape.error.issues[0]?.message ?? "unknown"}` }
  }

  if (shape.data.type === "final") {
    return { ok: true, kind: "final", content: shape.data.content }
  }

  const byName = new Map(manifest.map((t) => [t.name, t]))
  const seenIds = new Set<string>()
  const calls: ValidatedToolCall[] = []
  let counter = 0

  for (const call of shape.data.calls) {
    if (!byName.has(call.name)) {
      const known = [...byName.keys()].join(", ")
      return { ok: false, parseError: `Unknown tool "${call.name}". Available tools: ${known}` }
    }
    if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments)) {
      return { ok: false, parseError: `Tool call "${call.name}" arguments must be a JSON object.` }
    }
    if (opts.strictSchemas !== false) {
      const tool = byName.get(call.name)
      const validate = validatorFor(call.name, tool?.parameters)
      if (validate && !validate(call.arguments)) {
        const err = validate.errors?.[0]
        return {
          ok: false,
          parseError: `Tool call "${call.name}" arguments violate its JSON Schema${err ? `: ${err.instancePath} ${err.message}` : ""}.`,
        }
      }
    }
    let id = call.id
    if (!id) {
      counter++
      id = `call_${counter}_${Math.random().toString(36).slice(2, 8)}`
    }
    if (seenIds.has(id)) {
      return { ok: false, parseError: `Duplicate tool call id "${id}".` }
    }
    seenIds.add(id)
    calls.push({ id, name: call.name, arguments: call.arguments as Record<string, unknown> })
  }

  return { ok: true, kind: "tool_calls", calls }
}

/** Convenience: throw a typed error for hard protocol failure. */
export function protocolFailure(detail: string): CgptError {
  return new CgptError(
    `ChatGPT returned an invalid bridge response twice. No tool call was executed. Detail: ${detail}`,
    Codes.ProtocolFailed,
  )
}
