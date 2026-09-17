import { describe, it, expect } from "vitest"
import { redact, preview } from "../../src/security/redaction.js"
import { checkBearer, loadToken, rotateToken } from "../../src/security/auth.js"

describe("redaction", () => {
  it("redacts bearer tokens", () => {
    const out = redact("Authorization: Bearer abc123def")
    expect(out).not.toContain("abc123def")
    expect(out).toContain("[REDACTED]")
  })
  it("redacts api keys and tokens in json", () => {
    expect(redact('{"apiKey":"secret1"}')).not.toContain("secret1")
    expect(redact('{"token":"xyz"}')).not.toContain("xyz")
  })
  it("redacts ENV_VAR= style secrets", () => {
    expect(redact("MY_SECRET=hunter2")).not.toContain("hunter2")
    expect(redact("API_TOKEN=abc123")).toContain("[REDACTED]")
  })
  it("leaves normal text alone", () => {
    expect(redact("read src/index.ts and run npm test")).toBe("read src/index.ts and run npm test")
  })
  it("preview truncates and redacts", () => {
    const p = preview("MY_TOKEN=abc " + "x".repeat(500))
    expect(p.length).toBeLessThan(200)
    expect(p).not.toContain("abc")
  })
})

describe("bearer auth", () => {
  it("accepts correct bearer, rejects wrong/missing", async () => {
    const stateBefore = process.env.CGPT_STATE_DIR
    process.env.CGPT_STATE_DIR = "/tmp/cgpt-auth-test-" + Math.random().toString(36).slice(2)
    const token = await rotateToken()
    expect(checkBearer(`Bearer ${token}`, token)).toBe(true)
    expect(checkBearer(`Bearer wrong`, token)).toBe(false)
    expect(checkBearer(undefined, token)).toBe(false)
    expect(checkBearer(token, token)).toBe(true) // raw token also accepted
    expect(await loadToken()).toBe(token)
    if (stateBefore === undefined) delete process.env.CGPT_STATE_DIR
    else process.env.CGPT_STATE_DIR = stateBefore
  })
})
