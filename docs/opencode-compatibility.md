# OpenCode compatibility

## Detected environment (audit evidence)

- Binary: `/Users/ati/.opencode/bin/opencode`
- `opencode --version` → `1.18.31`
- Bundled plugin types: `@opencode-ai/plugin@1.18.21` at
  `/Users/ati/.opencode/node_modules/@opencode-ai/plugin`
- Runtime: Node.js `v24.20.0`, macOS arm64

## APIs verified against the installed types (not assumed)

From `@opencode-ai/plugin/dist/index.d.ts` (1.18.x):

- `PluginInput` = `{ client, project, directory, worktree, serverUrl, $, ... }`
  — `directory` is OpenCode's runtime directory, `worktree` the git worktree.
- Hook `"chat.headers"?: (input, output) => Promise<void>` with
  `input = { sessionID, agent, model, provider, message }` and
  `output = { headers: Record<string, string> }` — used to inject
  `x-cgpt-session-id`, `x-cgpt-directory`, `x-cgpt-worktree` on every model
  request (including small-model requests).

From the official docs (opencode.ai/docs, retrieved 2026-09):

- Global plugins auto-load from `~/.config/opencode/plugins/` — this is how
  the metadata plugin is installed (no npm publish required).
- Custom provider shape used by the installer:

```json
{
  "provider": {
    "cgpt-project": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ChatGPT Project Web",
      "options": { "baseURL": "http://127.0.0.1:3210/v1", "apiKey": "..." },
      "models": { "chatgpt-project-web": { "name": "chatgpt-project-web" } }
    }
  }
}
```

- Agent + permission shapes (granular patterns, `external_directory`,
  `.env` read defaults) verified against docs/permissions and used for the
  `cgpt-build` agent.
- Non-interactive E2E: `opencode run --model cgpt-project/chatgpt-project-web
  --agent cgpt-build "..."`.

## Compatibility policy

This implementation targets the current OpenCode generation (1.18.x) using
the `chat.headers` hook and the documented custom-provider config. No older
hook names are used. If future support for another generation is needed, it
belongs in `src/opencode/compat/` as an explicit adapter — the rest of the
codebase must stay version-agnostic.

Observed behaviors that shaped the design:

- OpenCode re-sends the full message history each request (system + user +
  assistant + tool results) → the bridge ledger/delta design in
  `docs/architecture.md` §4.
- OpenCode may issue small-model requests (session titles) → installer sets
  `small_model` to the bridge model so those requests also authenticate and
  route correctly; they appear as ordinary turns in the same session
  conversation.
- `stream: true` is used by default → the bridge buffers the ChatGPT answer
  and emits a syntactically correct SSE sequence (documented V1 tradeoff).
