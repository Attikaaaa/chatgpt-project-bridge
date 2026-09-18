# chatgpt-project-bridge (`cgpt`)

Use a **ChatGPT Web Project** as the model backend for **OpenCode**, while
OpenCode remains the only executor of tools.

```
ChatGPT = decides which tool should be used
OpenCode = actually executes that tool (read/edit/bash/git/tests/permissions)
```

The bridge is a local daemon that exposes an OpenAI-compatible API on
`127.0.0.1:3210/v1`, routes every OpenCode session to a conversation inside
your bound ChatGPT Project, translates OpenCode's tool definitions into a
JSON transport protocol the web model can answer, and validates every tool
call before OpenCode executes it. The bridge never reads, writes, or
executes anything in your repository.

## Architecture

See `docs/architecture.md` for the full design and `docs/protocol.md` for
the transport protocol. Short version:

```
OpenCode (your cwd) ──HTTP──▶ cgpt serve (127.0.0.1, bearer token)
                                 │ workspace routing (canonical dir → Project)
                                 │ session routing ((dir, session) → conversation)
                                 │ delta sync (only new messages are sent)
                                 ▼
                     Playwright (dedicated persistent profile)
                                 ▼
                     ChatGPT Web → your Project
```

## Requirements

- Node.js 22+ (tested with 24.x)
- OpenCode 1.18.x (tested with 1.18.31)
- A Chromium-family browser: Chrome, Edge, Brave, or Chromium (auto-discovered;
  override with `cgpt config set browserExecutable <path>`)
- A ChatGPT account with access to Projects (Plus/Pro/team), logged in once

## Install

```bash
git clone <this repo> && cd chatgpt-project-bridge
npm install
npm run build
npm link          # optional: puts `cgpt` on your PATH
```

## First login

```bash
cgpt login
```

Opens a **visible** browser window using a dedicated persistent profile
(never your personal browser profile). Log in to ChatGPT manually in that
window. `cgpt` detects the login, closes the browser, relaunches it, and
verifies the session persists. Password collection, cookie stealing, and
CAPTCHA/anti-bot bypass are not implemented — if ChatGPT shows a challenge,
solve it manually in the window.

## OpenCode installation

```bash
cgpt opencode install
```

Idempotent. It:

- adds provider `cgpt-project` (model `chatgpt-project-web`) to your global
  OpenCode config — creating a sibling `opencode.json` if your config is
  JSONC (your file is never touched; verified merge behavior), with a
  timestamped backup when editing an existing JSON config,
- adds a `cgpt-build` agent with safe permissions (external directories
  denied, `git push` denied, `rm` denied, other bash asks, edits allowed),
- installs the metadata plugin `~/.config/opencode/plugins/cgpt-bridge.js`
  (injects `x-cgpt-session-id` / `x-cgpt-directory` / `x-cgpt-worktree`),
- sets `small_model` to the bridge model **only if unset**,
- generates the local bearer token (stored 0600 in the state dir) and
  chmods the config 0600 (it contains the token),
- `cgpt opencode uninstall` removes exactly those pieces again.

If your OpenCode config cannot be edited safely, the exact snippet is
printed instead — nothing is modified.

## Bind a repository

```bash
cd /path/to/project-x
cgpt bind "https://chatgpt.com/g/g-p-xxxx/project-name"
```

The URL is syntax-checked, then opened in the authenticated profile; the
binding is saved **only** after the page is verified to be a reachable
ChatGPT Project with a prompt composer. Bindings live in user state
(macOS: `~/Library/Application Support/cgpt/workspaces.json`), never in the
repository. Different repositories can bind different Projects.

## Start the bridge

```bash
cgpt serve            # binds 127.0.0.1:3210, generates token if missing
```

## Start OpenCode

```bash
cd /path/to/project-x
opencode
```

Pick provider **cgpt-project** → model **chatgpt-project-web** (or press
Tab to select the `cgpt-build` agent). The model ID represents "whatever
model the bound ChatGPT Project serves" — it is not a fabricated OpenAI
model name.

Non-interactive:

```bash
opencode run --model cgpt-project/chatgpt-project-web "why does the login refresh fail occasionally? fix it with the smallest safe change and run the tests"
```

## Example coding task

Ask in OpenCode:

> Find why login refresh occasionally fails. Fix it with the smallest safe change. Run relevant tests.

Flow: OpenCode sends the model request → the bridge routes it to the bound
Project conversation → ChatGPT requests `read`/`grep` tools → OpenCode
reads your files → tool results return through the bridge → ChatGPT
requests an edit → OpenCode edits → ChatGPT requests the test command →
OpenCode executes it → ChatGPT sees the real output → final answer.

## Multiple repositories

```bash
cd ~/code/game     && cgpt bind "<project-url-1>"
cd ~/code/website  && cgpt bind "<project-url-2>"
```

Each OpenCode session routes by the **current runtime directory** (injected
as a header by the plugin; the bridge canonicalizes it). A session started
in `~/code/game` can never edit `~/code/website`: the `cgpt-build` agent
denies external directories, and the bridge routes conversations by the
canonical directory in the request metadata.

## Session behavior

- Every OpenCode session gets a **new** conversation inside the bound
  Project; mappings persist across bridge restarts.
- Only the delta of new messages is sent to ChatGPT (a ledger of message
  fingerprints prevents duplicate context).
- If the OpenCode history diverges (compaction, fork, replay), the bridge
  resyncs into a **new** Project conversation with one canonical snapshot —
  it never guesses and never sends to "whatever chat is open".
- `cgpt session reset <id>` forgets the mapping for a session.

## Project memory behavior

Project instructions, Project files, and Project-restricted memory are
native ChatGPT features and are used as-is (additive context). The bridge
never overwrites your Project instructions and never uploads your
repository. `cgpt project-instructions` prints an optional, short,
additive snippet you *may* paste into Project instructions.

## Security

- Daemon binds `127.0.0.1` only; random bearer token required (0600 state
  file, constant-time compare, never logged).
- `/health` reveals nothing about auth/bindings.
- Logs never contain cookies, tokens, full prompts, or `.env` values;
  full body logging requires `cgpt serve --unsafe-debug`.
- No hidden/private ChatGPT endpoints are used — only the normal web UI.
- No rate-limit, CAPTCHA, or bot-protection circumvention; if the service
  refuses, the real error is surfaced.
- OpenCode's permission model is untouched by default; the shipped
  `cgpt-build` agent denies external directories and `git push`.

## Diagnostics

```bash
cgpt doctor            # environment + browser + binding checks (no messages sent)
cgpt doctor --active   # additionally submits one harmless diagnostic prompt
cgpt status            # daemon reachability + binding
cgpt binding           # the binding for the current directory
cgpt sessions          # stored (workspace, session) → conversation mappings
cgpt browser-profile   # path of the dedicated browser profile
```

## Canary gates (optional, active)

These prove Project-context delivery by submitting real prompts. They
temporarily modify YOUR Project (you prepare the canaries manually) and are
therefore opt-in:

1. `G04` — put `PROJECT_INSTRUCTION_CANARY_<random>` in the Project
   instructions, then:
   `node scripts/g04-g06-canaries.mjs --instruction-canary PROJECT_INSTRUCTION_CANARY_<random>`
2. `G05` — add `BRIDGE_CANARY.md` containing `PROJECT_FILE_CANARY_<random>`
   to the Project files, then pass `--file-canary <value>`
3. `G06` — in another chat of the same Project, tell ChatGPT:
   "Memory canary: <value>. Remember this." then pass `--memory-canary <value>`
   (outcome depends on ChatGPT Project memory settings; the observation is
   recorded honestly, never fabricated).

## Known limitations

- **Serialized browser access**: one interactive profile → ChatGPT requests
  are processed one at a time (correctness over concurrency).
- **Buffered streaming**: `stream: true` returns a syntactically correct
  SSE sequence after ChatGPT finishes; no token-by-token DOM streaming.
- **Token accounting**: not measurable through the web UI; `usage` is
  omitted/null rather than fabricated. The configured context limit
  (128k) is a bridge transport budget, not a model spec.
- **Anonymous-state UI**: some automation-friendly attributes differ before
  login; the implementation handles both UI variants.
- Browser must stay logged in; if ChatGPT logs the profile out, run
  `cgpt login` again.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No ChatGPT Project is bound to: …` | `cd` into the repo, run `cgpt bind <url>` |
| `ChatGPT browser profile is not authenticated` | run `cgpt login` |
| `Missing X-CGPT-Directory header` | run `cgpt opencode install` (plugin missing), restart OpenCode |
| `Configured ChatGPT Project could not be verified` | check the Project URL exists and the account can access it; `cgpt doctor` |
| `ChatGPT returned an invalid bridge response twice` | retry the request; if persistent, `cgpt serve --unsafe-debug` and inspect `~/Library/Application Support/cgpt/logs/cgpt.log` |
| Provider missing in `/models` | `cgpt opencode install`, then restart OpenCode |
| Wrong workspace edited | never expected — verify with `cgpt status` that the binding matches `pwd` |

## Uninstall

```bash
cgpt opencode uninstall   # removes provider/agent/plugin from OpenCode
cgpt unbind               # per-repository binding
rm -rf ~/Library/Application\ Support/cgpt   # state, profile, sessions, logs
```

## Development

```bash
npm test                          # unit + integration (deterministic, fake backend)
node scripts/g01-environment.mjs  # gates; see proof/feasibility.json
npm run build && npm run typecheck
```

Gate scripts (G01…G17) live in `scripts/` and write evidence to
`proof/feasibility.json`. Private proof artifacts (screenshots) are
gitignored under `proof/private/`.

## License

MIT. ChatGPT web-automation selector concepts are reused from
[RPG-478/codex-chatgpt-bridge](https://github.com/RPG-478/codex-chatgpt-bridge)
(MIT, commit `49384fc`) — see `docs/upstream-audit.md` for the full audit.
