/**
 * PW-FALLBACK: CDP-based Electron test harness.
 *
 * Root cause: Playwright 1.60 _electron.launch() deadlocks with Electron 41.2.1
 * because __playwright_run()'s Promise await across Node inspector contexts fails.
 * Proven by a 10-line fixture (qualification/minimal-fixture/main.js) that
 * reproduces the identical _electron.launch() timeout.
 *
 * Fallback: Launch Electron directly with --remote-debugging-port=9222
 * (already configured in dev mode at index.ts:190), wait for the CDP
 * endpoint, connect Playwright via chromium.connectOverCDP(), and interact
 * with renderer windows. Main-process evaluation is unavailable with CDP,
 * but renderer-side IPC testing and window interaction satisfy RC-09/10/11.
 *
 * Removal condition: When Playwright releases a fix for Electron 41
 * _electron.launch() deadlock, revert to _electron.launch().
 */
import { chromium } from "playwright"

export interface CdpHarness {
  page: Awaited<ReturnType<typeof chromium.connectOverCDP>> extends infer B
    ? B extends { firstPage: () => Promise<infer P> } ? P : never
    : never
  close: () => Promise<void>
}

export async function launchElectronViaCdp(
  electronPath: string,
  mainEntry: string,
  tempDir: string,
): Promise<CdpHarness> {
  const { spawn } = await import("node:child_process")

  const child = spawn(electronPath, [mainEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCODE_HOME: tempDir,
      OPENCODE_DB: ":memory:",
      TRIBUNUS_DB: ":memory:",
      TRIBUNUS_TEST_ONBOARDING: "1",
      TRIBUNUS_NO_UPDATE: "1",
      TRIBUNUS_CHANNEL: "dev",
      OPENCODE_CHANNEL: "dev",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (d: Buffer) => process.stdout.write(d))
  child.stderr.on("data", (d: Buffer) => process.stderr.write(d))

  // Wait for CDP endpoint to become available (max 30s)
  const cdpUrl = await waitForCdp(30_000)

  const browser = await chromium.connectOverCDP(cdpUrl)
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) throw new Error("No page found after CDP connection")

  return {
    page,
    close: async () => {
      await browser.close()
      child.kill()
    },
  }
}

async function waitForCdp(timeoutMs: number): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch("http://127.0.0.1:9222/json/version")
      const data = await resp.json() as { webSocketDebuggerUrl: string }
      if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`CDP endpoint not available after ${timeoutMs}ms`)
}
