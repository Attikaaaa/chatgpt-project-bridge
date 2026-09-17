import { randomBytes } from "node:crypto"
import { chmod, readFile, unlink } from "node:fs/promises"
import { tokenPath } from "../state/paths.js"
import { atomicWriteText } from "../state/atomic-store.js"
import { constantTimeEqual } from "../util/crypto.js"

/** Load the local daemon bearer token, or null when absent. */
export async function loadToken(): Promise<string | null> {
  try {
    const raw = await readFile(tokenPath(), "utf8")
    const t = raw.trim()
    return t.length > 0 ? t : null
  } catch {
    return null
  }
}

/** Generate and persist a new token with 0600 permissions. */
export async function rotateToken(): Promise<string> {
  const token = randomBytes(24).toString("hex")
  await atomicWriteText(tokenPath(), token + "\n", 0o600)
  try {
    await chmod(tokenPath(), 0o600)
  } catch {
    /* chmod unsupported on some platforms */
  }
  return token
}

export async function deleteToken(): Promise<void> {
  await unlink(tokenPath()).catch(() => {})
}

/** Constant-time bearer check. */
export function checkBearer(presented: string | undefined, expected: string): boolean {
  if (!presented) return false
  const m = presented.match(/^Bearer\s+(.+)$/i)
  const value = m?.[1] ?? presented
  if (value === undefined) return false
  return constantTimeEqual(value, expected)
}
