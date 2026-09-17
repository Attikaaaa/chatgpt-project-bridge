/**
 * Source-controlled template for the global OpenCode metadata plugin.
 * Installed to ~/.config/opencode/plugins/cgpt-bridge.js
 * The MARKER line lets the uninstaller identify files it owns.
 */
export const PLUGIN_MARKER = "cgpt-project-bridge:owned"

export const PLUGIN_TEMPLATE = `// ${PLUGIN_MARKER} — metadata plugin for the local ChatGPT Project bridge.
// Injects OpenCode runtime context as HTTP headers on every model request.
// Safe to delete; run "cgpt opencode uninstall" to remove cleanly.
export const CgptBridgePlugin = async ({ directory, worktree }) => {
  return {
    "chat.headers": async (input, output) => {
      output.headers["x-cgpt-session-id"] = String(input.sessionID ?? "")
      output.headers["x-cgpt-directory"] = directory
      output.headers["x-cgpt-worktree"] = worktree ?? directory
    },
  }
}
`
