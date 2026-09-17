import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) {
    // compare against self to keep timing uniform, then fail
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}
