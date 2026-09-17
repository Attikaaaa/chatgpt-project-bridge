#!/usr/bin/env node
/** Probe: launch persistent profile browser, navigate to chatgpt.com, report state + screenshot. */
import { PlaywrightChatBackend } from "../dist/browser/playwright.js"

const backend = new PlaywrightChatBackend({
  headless: process.argv.includes("--headless"),
  screenshotsDir: "proof/private",
})
try {
  const auth = await backend.verifyAuth()
  console.log(JSON.stringify({ auth }, null, 2))
} finally {
  await backend.close()
}
