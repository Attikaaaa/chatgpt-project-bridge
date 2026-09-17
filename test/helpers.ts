import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Fresh isolated state dir per test file. */
export function newStateDir(): string {
  return mkdtempSync(join(tmpdir(), "cgpt-test-"))
}

export const BOUND_DIR = "/tmp/cgpt-fake-workspace-a"
export const PROJECT_URL = "https://chatgpt.com/fake-project/g-p-testproj123"

export const TEST_TOOL = {
  type: "function" as const,
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
}
