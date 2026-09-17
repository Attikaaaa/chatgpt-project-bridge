# Bridge transport protocol

The ChatGPT web model does not emit native OpenAI tool calls. The bridge
wraps each session conversation with a deterministic transport protocol.

## Bootstrap message (sent once per conversation)

Composed by `src/chatgpt/transport.ts`:

1. **Transport prompt** (source-controlled template): tells the model it is
   the reasoning component of an OpenCode coding session, that the local
   filesystem/shell are not directly available, that it must use only the
   current tool manifest, and that it must answer with exactly one JSON
   transport object (tool calls or final answer), never prose, never
   invented tools, never claimed successes without a tool result, and never
   exposed hidden reasoning.
2. **Tool manifest**: a JSON array of OpenCode-provided tools
   (`{ name, description, parameters }`), sent when the tools hash changes.
3. **System context**: OpenCode's system messages, sent when the system
   hash changes.

Project instructions/files/memory are ChatGPT-native context and are never
overwritten; they are additive to the above.

## Per-turn message

Only the unsynchronized delta of OpenCode messages, rendered readably:

```
[TOOL RESULT] call_id=<id> tool=<name> status=ok|error
<result content or error text>

[USER]
<content>

Respond with the JSON transport object now.
```

Assistant messages produced by this bridge are not re-sent (they already
exist in the conversation). Assistant messages from other providers are
rendered as `[ASSISTANT] ...` so ChatGPT sees them.

## Response schema

```json
{
  "type": "tool_calls",
  "calls": [
    { "id": "call_unique_id", "name": "tool_name", "arguments": {} }
  ]
}
```
or
```json
{ "type": "final", "content": "final user-visible response" }
```

- Exactly one top-level JSON object. No prose outside it during transport
  turns. No other top-level types.
- The bridge extracts the first balanced JSON object (tolerating markdown
  code fences), validates it with AJV, checks tool names against the
  current manifest, validates arguments against each tool's JSON Schema,
  and enforces unique call IDs. Missing IDs are generated deterministically.
- On a first violation the bridge sends exactly one repair instruction
  ("Return the same intended action again as one valid JSON object only").
  A second violation is a hard error: no tool call is executed, the OpenAI
  request fails with an explicit diagnostic.

## Wire mapping

- `type: "tool_calls"` → OpenAI assistant message with `tool_calls`,
  `finish_reason: "tool_calls"`. OpenCode executes the tools and sends
  `tool` role messages back, which the bridge correlates by
  `tool_call_id` (and tool name) into the next turn message.
- `type: "final"` → assistant content message, `finish_reason: "stop"`.
  Transport JSON never leaks into user-visible output.

## Resync

If the incoming history prefix does not match the ledger
(compaction/fork/replay/provider retry), the bridge creates a NEW
conversation in the same Project, sends one canonical snapshot (bootstrap +
full history including assistant turns), and replaces the stored session
mapping. The old conversation is left untouched.
