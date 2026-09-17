# Architecture

## What this is

`chatgpt-project-bridge` (CLI: `cgpt`) lets OpenCode use a ChatGPT Web
Project as its model backend. ChatGPT reasons; OpenCode executes.

There is a hard separation:

```
ChatGPT  = decides which tool should be used
OpenCode = actually executes that tool
```

The bridge never becomes a second filesystem executor. It never reads,
writes, or executes anything in the user's repository.

## Components

```
OpenCode (user cwd: /path/to/project-x)
  │  @ai-sdk/openai-compatible provider → http://127.0.0.1:3210/v1
  │  global plugin injects metadata headers (sessionID, directory, worktree)
  ▼
cgpt serve  (local daemon, bearer token, 127.0.0.1 only)
  │  OpenAI-compatible surface: /v1/models, /v1/chat/completions
  │  workspace routing: canonical dir → bound ChatGPT Project
  │  session routing: (dir, sessionID) → ChatGPT conversation
  │  delta sync: send only new messages (ledger of fingerprints)
  │  tool transport: OpenAI tool defs ⇄ JSON transport protocol
  │  validation: AJV tool-schema validation, one repair attempt max
  ▼
Playwright (persistent dedicated Chromium profile, headful)
  ▼
ChatGPT Web (normal UI only — no private endpoints)
  ▼
ChatGPT Project (instructions / files / memory / per-session chats)
```

## Load-bearing decisions

### 1. Current directory is authoritative

Every `/v1/chat/completions` request must carry OpenCode's runtime context
via headers injected by the global OpenCode plugin:

- `x-cgpt-session-id` — OpenCode session ID
- `x-cgpt-directory` — OpenCode runtime directory (cwd at startup)
- `x-cgpt-worktree` — git worktree path

The bridge canonicalizes the directory (`fs.realpath`) and uses
`(canonicalDirectory, sessionID)` as the session key. If the header is
missing the request fails closed with an actionable error (raw curl clients
may pass the headers explicitly). The bridge never infers the workspace
from ChatGPT text, page titles, repository names, or previous state.

### 2. Workspace → Project binding

`cgpt bind <url>` stores, in user-local state (outside any repo):

```
canonical workspace path → { projectUrl, projectId, boundAt, lastVerifiedAt }
```

Binding only succeeds after a live browser check: navigate, verify the page
is a ChatGPT Project, verify the prompt composer exists.

### 3. Session mapping

Key `(canonicalWorkspace, opencodeSessionID)` maps to a ChatGPT
conversation reference inside the bound Project. New sessions create a NEW
conversation in the Project. Resumed sessions navigate to the stored
conversation and verify project membership; if membership cannot be proven
the bridge resyncs into a fresh conversation (never sends to "whatever chat
is open"). All mappings are persisted atomically and survive daemon
restarts.

### 4. Delta synchronization (no duplicate context)

A per-session ledger stores fingerprints (sha256) of every OpenCode message
already present in the ChatGPT conversation. On each request:

- incoming history extends the known prefix → send only the new delta
- system prompt / tool manifest hashed → sent once, re-sent only on change
- prefix mismatch (compaction, fork, replay, provider retry) → deterministic
  resync: create a fresh ChatGPT conversation in the same Project, send one
  canonical snapshot of the full history, replace the session mapping.

Assistant messages are normally not re-sent (ChatGPT produced them); the
bridge records the hashes of responses it produced so assistant turns from
*other* providers (user switched models mid-session) are re-sent.

### 5. Tool transport protocol

ChatGPT web models do not emit native OpenAI tool calls. The bridge
translates OpenCode's tool definitions into a model-visible manifest and
requires exactly one JSON object per transport turn:

```json
{ "type": "tool_calls", "calls": [{ "id": "call_1", "name": "read", "arguments": {} }] }
```
or
```json
{ "type": "final", "content": "final answer" }
```

Validation: tool name must exist in the current request's tool set,
arguments must be valid JSON satisfying the tool's JSON Schema (AJV), IDs
unique. Malformed output gets exactly ONE repair attempt; a second failure
is a hard provider error. See `docs/protocol.md`.

### 6. Browser automation

Headful persistent Chromium context (dedicated profile, never the user's
own browser profile). Semantic/test-id selectors with fallbacks; completion
detection = stop-control disappearance + text stability debounce; the
response to a submission is identified by assistant-message count captured
before submission. All browser access is serialized behind a single mutex
(one interactive profile ⇒ correctness over concurrency; documented
limitation). Retries are conservative: ambiguous prompt submission is never
retried (duplicate-submission danger).

### 7. Security model

- Daemon binds 127.0.0.1 only; random bearer token generated at install,
  stored 0600 in the state dir; constant-time comparison; never logged.
- No cookies, no auth state in logs or `/health`.
- Prompt bodies are logged only with explicit `--unsafe-debug` / debug flag,
  redacted.
- The bridge never touches repository files, never runs shell commands,
  never runs git. OpenCode's permission model (including
  `external_directory`, `.env` protections) is untouched by default; the
  shipped `cgpt-build` agent additionally denies external directories and
  `git push` by default.

### 8. State layout (platform conventions)

- macOS:   `~/Library/Application Support/cgpt/`
- Linux:   `~/.local/state/cgpt/` (config `~/.config/cgpt/`)
- Windows: `%APPDATA%\cgpt\`

Contains: `config.json`, `token` (0600), `workspaces.json`,
`sessions/*.json`, `logs/cgpt.log`, `browser-profile/`. All JSON state is
written atomically (temp file + rename). Browser profile, logs, and session
state are private to the user account; none of it belongs in git.

## What the bridge does NOT do

- No repository file/bash/git access (that is OpenCode's job)
- No repository sync into ChatGPT Project files
- No reimplementation of Project memory/instructions (they are additive
  context that ChatGPT applies natively)
- No hidden/private ChatGPT endpoints, no token extraction, no anti-bot
  bypass, no rate-limit circumvention
- No fabrication of model metadata, pricing, or token accounting
