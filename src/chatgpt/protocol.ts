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
 * Deterministic lenient repair of model-emitted JSON:
 * 1. Escape literal control characters inside string literals.
 * 2. Escape unescaped quotes inside string literals. A `"` inside a string
 *    is treated as CONTENT when the next non-whitespace character is not a
 *    structural one (`,}]:` or another closing quote pattern); otherwise it
 *    is the string terminator. Only used after strict parsing failed —
 *    schema validation still runs afterwards, so a wrong repair fails
 *    safely.
 */
function repairJsonString(json: string): string {
  let out = ""
  let inString = false
  let escaped = false
  const n = json.length
  for (let i = 0; i < n; i++) {
    const ch = json[i]
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === "\\") {
        out += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        // Lookahead: structural next char → terminator; else content quote.
        let j = i + 1
        while (j < n && /\s/.test(json[j] ?? "")) j++
        const next = j < n ? (json[j] ?? "") : ""
        if (next === "," || next === "}" || next === "]" || next === ":") {
          inString = false
          out += ch
        } else {
          out += '\\"'
        }
        continue
      }
      if (ch === "\n") {
        out += "\\n"
        continue
      }
      if (ch === "\r") {
        out += "\\r"
        continue
      }
      if (ch === "\t") {
        out += "\\t"
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = true
    }
    out += ch
  }
  return out
}

/**
 * Parse the extracted JSON: strict first, then a deterministic lenient pass
 * (control chars / unescaped quotes inside strings, trailing commas). Shape
 * validation still applies afterwards.
 */
function parseJsonLenient(jsonStr: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(jsonStr) }
  } catch (strictError) {
    try {
      const repaired = repairJsonString(jsonStr).replace(/,\s*([}\]])/g, "$1")
      return { ok: true, value: JSON.parse(repaired) }
    } catch {
      return { ok: false, error: (strictError as Error).message }
    }
  }
}

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

  const parsedJson = parseJsonLenient(jsonStr)
  if (!parsedJson.ok) {
    return { ok: false, parseError: `Response JSON is not parseable: ${parsedJson.error}` }
  }

  const shape = TransportResponseSchema.safeParse(parsedJson.value)
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
