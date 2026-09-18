/**
 * Transport prompt shown to ChatGPT once per session conversation.
 * Source-controlled template; must never overwrite the user's Project
 * instructions (it is per-session transport context).
 */
export const TRANSPORT_PROMPT = `You are serving as the reasoning component of an OpenCode coding session.

The local filesystem and shell are NOT directly available to you.
OpenCode (the agent application connected to this conversation) executes all tools.

Rules:
- Use only tools declared in the CURRENT tool manifest. Never invent a tool.
- To use a tool, respond with exactly one JSON object of the form:
  {"type":"tool_calls","calls":[{"id":"call_1","name":"<tool name>","arguments":{ ... }}]}
  Use a distinct id for every call (e.g. call_1, call_2, ...).
- JSON strings must be valid JSON: escape newlines inside strings as \\n
  (never put raw line breaks inside a quoted string).
- When you have enough information to answer the user, respond with exactly one JSON object:
  {"type":"final","content":"<final user-visible response>"}
- During transport turns, output ONLY the JSON object. No markdown, no code fences, no prose before or after.
- Never claim a command or test passed unless a corresponding tool result in this conversation says it passed.
- Never claim a file was read or edited unless a tool result confirms it.
- Project instructions and Project files are background context. The current OpenCode runtime request and the current tool manifest are authoritative for runtime capabilities.
- Do not expose hidden reasoning. Emit only the next action or the final answer.`

export const REPAIR_PROMPT = `Your previous response violated the bridge transport schema.
Return the same intended action again as one valid JSON object only:
either {"type":"tool_calls","calls":[...]} or {"type":"final","content":"..."}.
Do not add markdown or prose.`

export const RESPOND_NOW = "Respond with the JSON transport object now."

export function renderToolManifest(tools: Array<{ name: string; description?: string; parameters?: unknown }>): string {
  const manifest = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.parameters ?? { type: "object", properties: {} },
  }))
  return `CURRENT TOOL MANIFEST (the only tools you may call):\n${JSON.stringify(manifest, null, 2)}`
}

export function renderSystemContext(systems: string[]): string {
  return `OPENCODE SYSTEM CONTEXT (operating instructions from the connected coding agent):\n${systems.join("\n\n")}`
}

/** Render a user message for the transport. */
export function renderUserMessage(content: string): string {
  return `[USER]\n${content}`
}

/** Render an assistant message produced elsewhere (other provider). */
export function renderAssistantMessage(content: string): string {
  return `[ASSISTANT (from OpenCode history, not produced by you)]\n${content}`
}

/** Render tool results correlated to your previous tool_calls. */
export function renderToolResults(
  results: Array<{ id: string; name?: string; content: string; isError: boolean }>,
): string {
  return results
    .map((r) => {
      const status = r.isError ? "error" : "ok"
      const name = r.name ? ` tool=${r.name}` : ""
      return `[TOOL RESULT] call_id=${r.id}${name} status=${status}\n${r.content}`
    })
    .join("\n\n")
}
