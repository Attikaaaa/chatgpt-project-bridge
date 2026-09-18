# Troubleshooting

Symptoms below are the observed failure modes of the bridge (fail-closed by
design). All commands assume the repo is built (`npm run build`).

## Provider / OpenCode side

| Error (from OpenCode or the bridge) | Cause | Fix |
| --- | --- | --- |
| `No ChatGPT Project is bound to: /path` | The runtime directory has no binding | `cd /path` then `cgpt bind <project-url>` |
| `Missing X-CGPT-Directory header…` | The metadata plugin is not installed or OpenCode was started before installing | `cgpt opencode install`, then restart OpenCode. Raw curl users: pass `X-CGPT-Directory` explicitly |
| `Unknown model "…"` (HTTP 404) | Requested model ≠ `chatgpt-project-web` | Select `cgpt-project/chatgpt-project-web` |
| HTTP 401 from the bridge | Token mismatch (config token vs state token) | Re-run `cgpt opencode install` (rewrites token into config), restart OpenCode |
| Provider missing from `/models` | Config not loaded | `cgpt opencode install`; check `opencode models \| grep cgpt` |
| `ChatGPT returned an invalid bridge response twice` | Model answered with prose twice (transport violation) | Retry. If persistent, run `cgpt serve --unsafe-debug` and inspect `~/Library/Application Support/cgpt/logs/cgpt.log` |

## Browser / ChatGPT side

| Error | Cause | Fix |
| --- | --- | --- |
| `ChatGPT browser profile is not authenticated` | Dedicated profile not logged in / logged out | `cgpt login` (manual login in the opened window) |
| `Configured ChatGPT Project could not be verified. No prompt was submitted.` | Project URL unreachable, not a Project page, or composer not found | Verify the URL opens the Project in a normal browser; check the account has access; `cgpt doctor` |
| `Prompt submission could not be confirmed…` | Send could not be verified — deliberately NOT retried (duplicate-prompt protection) | Check the ChatGPT window for a partially sent message; retry the request |
| `Navigation to … failed` | Network/Cloudflare/ChatGPT outage | Surfaced verbatim; retry when the site is reachable. No anti-bot bypass is implemented |
| Browser window does not appear | Executable not found | `cgpt config set browserExecutable "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` or point at any Chromium |

## State

State lives in `~/Library/Application Support/cgpt/` (macOS):
`config.json`, `token` (0600), `workspaces.json`, `sessions/`, `logs/`,
`browser-profile/`. All JSON writes are atomic (temp + rename); a crash
mid-write cannot corrupt state. Deleting `sessions/` makes every OpenCode
session start a fresh ChatGPT conversation on next use (safe).

## Logs

- Default logs: one JSON line per event on stderr + `logs/cgpt.log`.
- Never logged: cookies, bearer tokens, full prompts, `.env` values.
- `cgpt serve --unsafe-debug` additionally logs prompt/response bodies
  (redacted for obvious secret patterns).

## Diagnostics

```bash
cgpt doctor            # everything except message submission
cgpt doctor --active   # + one harmless diagnostic prompt in the bound Project
node scripts/proof-all.mjs   # rerun all gates, refresh proof/feasibility.json
```
