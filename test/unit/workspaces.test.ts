import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, realpathSync, symlinkSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  validateProjectUrlSyntax,
  projectIdFromUrl,
  canonicalWorkspace,
  setBinding,
  getBinding,
  removeBinding,
} from "../../src/state/workspaces.js"

describe("project URL validation", () => {
  it("accepts project URLs", () => {
    expect(validateProjectUrlSyntax("https://chatgpt.com/library/projects/abc-123")).toBeTruthy()
    expect(validateProjectUrlSyntax("https://chatgpt.com/g/g-p-68abcdef/slug")).toBeTruthy()
    expect(validateProjectUrlSyntax("https://chatgpt.com/g/g-p-68abcdef")).toBeTruthy()
  })
  it("rejects non-project URLs", () => {
    expect(() => validateProjectUrlSyntax("https://evil.com/project")).toThrow()
    expect(() => validateProjectUrlSyntax("https://chatgpt.com/c/12345")).toThrow()
    expect(() => validateProjectUrlSyntax("not a url")).toThrow()
    expect(() => validateProjectUrlSyntax("ftp://chatgpt.com/project")).toThrow()
  })
  it("normalizes and extracts project ids", () => {
    const n = validateProjectUrlSyntax("https://chatgpt.com/g/g-p-abc123?utm=x#frag")
    expect(n).toBe("https://chatgpt.com/g/g-p-abc123")
    expect(projectIdFromUrl(n)).toBe("g-p-abc123")
    expect(projectIdFromUrl("https://chatgpt.com/library/projects/123e4567-e89b")).toBe("123e4567-e89b")
  })
})

describe("workspace canonicalization", () => {
  const base = mkdtempSync(join(tmpdir(), "cgpt-canon-"))
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it("resolves symlinks", async () => {
    const real = join(base, "real")
    const link = join(base, "link")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(real)
    symlinkSync(real, link)
    expect(await canonicalWorkspace(link)).toBe(realpathSync(real))
  })
  it("falls back lexically for nonexistent paths", async () => {
    const p = join(base, "does-not-exist")
    expect(await canonicalWorkspace(p)).toBe(p)
  })
})

describe("workspace registry", () => {
  const stateBefore = process.env.CGPT_STATE_DIR
  let stateDir: string
  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cgpt-reg-"))
    process.env.CGPT_STATE_DIR = stateDir
  })
  afterAll(() => {
    if (stateBefore === undefined) delete process.env.CGPT_STATE_DIR
    else process.env.CGPT_STATE_DIR = stateBefore
    rmSync(stateDir, { recursive: true, force: true })
  })

  it("set/get/remove binding round trip", async () => {
    const dir = join(stateDir, "ws-a")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(dir)
    await setBinding(dir, "https://chatgpt.com/g/g-p-xyz")
    const got = await getBinding(dir)
    expect(got?.entry.projectUrl).toBe("https://chatgpt.com/g/g-p-xyz")
    expect(got?.entry.projectId).toBe("g-p-xyz")
    expect(await removeBinding(dir)).toBe(true)
    expect(await getBinding(dir)).toBeNull()
    expect(await removeBinding(dir)).toBe(false)
  })
})
