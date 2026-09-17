import { homedir, platform } from "node:os"
import { join } from "node:path"

/**
 * Platform-conventional state directories.
 * macOS:   ~/Library/Application Support/cgpt
 * Linux:   ~/.local/state/cgpt  (XDG)
 * Windows: %APPDATA%/cgpt
 */
export function stateDir(): string {
  if (process.env.CGPT_STATE_DIR) return process.env.CGPT_STATE_DIR
  const p = platform()
  const home = homedir()
  if (p === "darwin") return join(home, "Library", "Application Support", "cgpt")
  if (p === "win32") {
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming")
    return join(appdata, "cgpt")
  }
  const xdgState = process.env.XDG_STATE_HOME ?? join(home, ".local", "state")
  return join(xdgState, "cgpt")
}

export function browserProfileDir(): string {
  if (process.env.CGPT_BROWSER_PROFILE_DIR) return process.env.CGPT_BROWSER_PROFILE_DIR
  return join(stateDir(), "browser-profile")
}

export function tokenPath(): string {
  return join(stateDir(), "token")
}

export function configPath(): string {
  return join(stateDir(), "config.json")
}

export function workspacesPath(): string {
  return join(stateDir(), "workspaces.json")
}

export function sessionsDir(): string {
  return join(stateDir(), "sessions")
}

export function logsDir(): string {
  return join(stateDir(), "logs")
}
