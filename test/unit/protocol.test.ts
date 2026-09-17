import { describe, it, expect } from "vitest"
import { extractJsonObject, parseTransportResponse, protocolFailure } from "../../src/chatgpt/protocol.js"
import type { ToolManifestEntry } from "../../src/chatgpt/protocol.js"

const manifest: ToolManifestEntry[] = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "bash",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
]

describe("extractJsonObject", () => {
  it("finds bare JSON", () => {
    expect(extractJsonObject('{"type":"final","content":"x"}')).toBe('{"type":"final","content":"x"}')
  })
  it("finds JSON in code fences", () => {
    expect(extractJsonObject('```json\n{"type":"final","content":"x"}\n```')).toBe('{"type":"final","content":"x"}')
  })
  it("finds JSON with prose around it", () => {
    expect(extractJsonObject('Here you go:\n{"a":1}\nThanks!')).toBe('{"a":1}')
  })
  it("handles braces inside strings", () => {
    expect(extractJsonObject('{"c":"}{ not a brace }"}')).toBe('{"c":"}{ not a brace }"}')
  })
  it("returns null when unbalanced", () => {
    expect(extractJsonObject('{"a":')).toBeNull()
    expect(extractJsonObject("no json here")).toBeNull()
  })
})

describe("parseTransportResponse", () => {
  it("accepts valid tool_calls", () => {
    const r = parseTransportResponse('{"type":"tool_calls","calls":[{"id":"call_1","name":"read_file","arguments":{"path":"a"}}]}', manifest)
    expect(r).toEqual({ ok: true, kind: "tool_calls", calls: [{ id: "call_1", name: "read_file", arguments: { path: "a" } }] })
  })
  it("accepts valid final", () => {
    const r = parseTransportResponse('{"type":"final","content":"All done."}', manifest)
    expect(r).toEqual({ ok: true, kind: "final", content: "All done." })
  })
  it("generates ids when missing", () => {
    const r = parseTransportResponse('{"type":"tool_calls","calls":[{"name":"read_file","arguments":{"path":"a"}}]}', manifest)
    expect(r.ok && r.kind === "tool_calls" && r.calls[0].id).toBeTruthy()
  })
  it("rejects unknown tools with available list", () => {
    const r = parseTransportResponse('{"type":"tool_calls","calls":[{"id":"1","name":"hack_system","arguments":{}}]}', manifest)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.parseError).toContain("Available tools")
  })
  it("rejects schema violations", () => {
    const r = parseTransportResponse('{"type":"tool_calls","calls":[{"id":"1","name":"read_file","arguments":{"wrong":1}}]}', manifest)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.parseError).toContain("JSON Schema")
  })
  it("rejects non-object arguments", () => {
    const r = parseTransportResponse('{"type":"tool_calls","calls":[{"id":"1","name":"read_file","arguments":"path=a"}]}', manifest)
    expect(r.ok).toBe(false)
  })
  it("rejects duplicate call ids", () => {
    const r = parseTransportResponse(
      '{"type":"tool_calls","calls":[{"id":"1","name":"bash","arguments":{"command":"a"}},{"id":"1","name":"bash","arguments":{"command":"b"}}]}',
      manifest,
    )
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.parseError).toContain("Duplicate")
  })
  it("rejects wrong top-level shape", () => {
    expect(parseTransportResponse('{"type":"explode"}', manifest).ok).toBe(false)
    expect(parseTransportResponse('{"type":"tool_calls","calls":[]}', manifest).ok).toBe(false)
    expect(parseTransportResponse('plain prose answer', manifest).ok).toBe(false)
  })
  it("rejects unknown top-level keys via discriminated union", () => {
    expect(parseTransportResponse('{"type":"final","content":123}', manifest).ok).toBe(false)
  })
})

describe("protocolFailure", () => {
  it("produces the documented fail-closed message", () => {
    const err = protocolFailure("detail")
    expect(err.message).toContain("invalid bridge response twice")
    expect(err.message).toContain("No tool call was executed")
  })
})
