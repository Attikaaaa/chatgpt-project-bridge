/** Minimal CLI arg parser (shared by scripts and CLI). */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a || !a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}
