/**
 * Optional, ADDITIVE Project instructions a user MAY paste into their
 * ChatGPT Project instructions. Never required. Never written
 * automatically. The bridge never overwrites Project instructions.
 */
export const RECOMMENDED_PROJECT_INSTRUCTIONS = `Optional agent-bridge note (you can delete this):

When a message contains bridge transport instructions and JSON tool-call
requests, it comes from the OpenCode coding agent connected through the
local bridge. Follow the transport format exactly: reply with one JSON
object ({"type":"tool_calls",...} or {"type":"final",...}) and no prose
during those turns. Everything else in these Project instructions keeps
applying as normal.`
