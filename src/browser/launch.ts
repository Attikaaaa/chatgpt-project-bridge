import { access, constants, readdir } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { log } from "../util/log.js"

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

const WIN_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
]

const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/microsoft-edge",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Look for a Playwright-cached Chromium build (ms-playwright cache). */
async function playwrightCachedChromium(): Promise<string | null> {
  const bases = [
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : null,
  ].filter((b): b is string => Boolean(b))
  for (const base of bases) {
    let versions: string[] = []
    try {
      versions = await readdir(base)
    } catch {
      continue
    }
    const chromiumDirs = versions.filter((v) => v.startsWith("chromium-")).sort().reverse()
    for (const dir of chromiumDirs) {
      const p = platform()
      const sub =
        p === "darwin"
          ? join(base, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
          : p === "win32"
            ? join(base, dir, "chrome-win", "chrome.exe")
            : join(base, dir, "chrome-linux", "chrome")
      if (await exists(sub)) return sub
    }
  }
  return null
}

export interface BrowserLaunchInfo {
  executablePath: string | null
  channel: string | null
}

/**
 * Discover a usable browser. Order:
 * 1. env CGPT_BROWSER_EXECUTABLE
 * 2. config.browserExecutable / config.browserChannel
 * 3. system Chrome/Edge/Brave/Chromium
 * 4. Playwright-cached Chromium
 */
export async function discoverBrowser(cfg: { browserExecutable?: string; browserChannel?: string }): Promise<BrowserLaunchInfo> {
  const envPath = process.env.CGPT_BROWSER_EXECUTABLE
  if (envPath && (await exists(envPath))) {
    return { executablePath: envPath, channel: null }
  }
  if (cfg.browserExecutable && (await exists(cfg.browserExecutable))) {
    return { executablePath: cfg.browserExecutable, channel: null }
  }
  if (cfg.browserChannel) {
    return { executablePath: null, channel: cfg.browserChannel }
  }
  const candidates =
    platform() === "darwin" ? MAC_CANDIDATES : platform() === "win32" ? WIN_CANDIDATES : LINUX_CANDIDATES
  for (const c of candidates) {
    if (await exists(c)) return { executablePath: c, channel: null }
  }
  const cached = await playwrightCachedChromium()
  if (cached) {
    log.debug("using Playwright-cached Chromium", { path: cached })
    return { executablePath: cached, channel: null }
  }
  return { executablePath: null, channel: null }
}
