import { realpath } from "node:fs/promises"
import { z } from "zod"
import { workspacesPath } from "./paths.js"
import { atomicWriteJson, readJson } from "./atomic-store.js"
import { CgptError, Codes } from "../util/errors.js"

const ProjectUrlSchema = z
  .string()
  .url()
  .refine((u) => {
    try {
      const url = new URL(u)
      if (url.protocol !== "https:" && url.protocol !== "http:") return false
      const okHosts = ["chatgpt.com", "chat.openai.com"]
      if (!okHosts.includes(url.hostname.toLowerCase())) return false
      // Conservative: project URLs contain "/project" segments or a g-p- id.
      const path = decodeURIComponent(url.pathname)
      if (path.includes("project")) return true
      if (/\/g\/g-p-[A-Za-z0-9]+/.test(path)) return true
      return false
    } catch {
      return false
    }
  }, "must be a ChatGPT Project URL (https://chatgpt.com/...project...)")

export function validateProjectUrlSyntax(url: string): string {
  const parsed = ProjectUrlSchema.safeParse(url)
  if (!parsed.success) {
    throw new CgptError(
      `Not a plausible ChatGPT Project URL: ${url}. Expected something like https://chatgpt.com/g/g-p-... or a URL containing "/project".`,
      Codes.Config,
    )
  }
  return normalizeProjectUrl(url)
}

export function normalizeProjectUrl(url: string): string {
  const u = new URL(url)
  u.hash = ""
  // keep trailing project id; drop query params (utm etc.)
  u.search = ""
  return u.toString().replace(/\/$/, "")
}

/** Extract a stable project identity token from the URL, if possible. */
export function projectIdFromUrl(url: string): string | null {
  const m = url.match(/g-p-[A-Za-z0-9-]+/)
  if (m?.[0]) return m[0]
  const m2 = url.match(/projects\/([0-9a-f-]{8,})/i)
  if (m2?.[1]) return m2[1]
  return null
}

const WorkspaceEntrySchema = z.object({
  projectUrl: z.string(),
  projectId: z.string().nullable().default(null),
  boundAt: z.string(),
  lastVerifiedAt: z.string().nullable().default(null),
})
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>

type Registry = Record<string, WorkspaceEntry>

export async function loadRegistry(): Promise<Registry> {
  return readJson<Registry>(workspacesPath(), {})
}

export async function saveRegistry(reg: Registry): Promise<void> {
  await atomicWriteJson(workspacesPath(), reg)
}

/** Canonicalize a workspace path: resolve symlinks, absolute form. */
export async function canonicalWorkspace(dir: string): Promise<string> {
  try {
    return await realpath(dir)
  } catch {
    // nonexistent path: fall back to lexical resolution
    const resolved = (await import("node:path")).resolve(dir)
    if (process.platform === "win32") return resolved.toLowerCase()
    return resolved
  }
}

export async function setBinding(
  workspaceDir: string,
  projectUrl: string,
  opts: { projectId?: string | null } = {},
): Promise<WorkspaceEntry> {
  const canonical = await canonicalWorkspace(workspaceDir)
  const normalized = normalizeProjectUrl(projectUrl)
  const reg = await loadRegistry()
  const entry: WorkspaceEntry = {
    projectUrl: normalized,
    projectId: opts.projectId ?? projectIdFromUrl(normalized),
    boundAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  }
  reg[canonical] = entry
  await saveRegistry(reg)
  return entry
}

export async function getBinding(workspaceDir: string): Promise<{ dir: string; entry: WorkspaceEntry } | null> {
  const canonical = await canonicalWorkspace(workspaceDir)
  const reg = await loadRegistry()
  const entry = reg[canonical]
  if (!entry) return null
  return { dir: canonical, entry }
}

export async function removeBinding(workspaceDir: string): Promise<boolean> {
  const canonical = await canonicalWorkspace(workspaceDir)
  const reg = await loadRegistry()
  if (!reg[canonical]) return false
  delete reg[canonical]
  await saveRegistry(reg)
  return true
}

export async function markVerified(workspaceDir: string): Promise<void> {
  const canonical = await canonicalWorkspace(workspaceDir)
  const reg = await loadRegistry()
  const entry = reg[canonical]
  if (!entry) return
  entry.lastVerifiedAt = new Date().toISOString()
  await saveRegistry(reg)
}
