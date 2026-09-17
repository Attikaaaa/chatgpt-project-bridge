import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"

/**
 * Atomic JSON file update: write temp file in same dir, fsync, rename.
 * A crash mid-write can never corrupt the target.
 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`
  const payload = JSON.stringify(value, null, 2) + "\n"
  const fh = await open(tmp, "w", 0o600)
  try {
    await fh.writeFile(payload, "utf8")
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, path)
}

export async function atomicWriteText(path: string, text: string, mode: number = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`
  const fh = await open(tmp, "w", mode)
  try {
    await fh.writeFile(text, "utf8")
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, path)
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true }).catch(() => {})
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}
