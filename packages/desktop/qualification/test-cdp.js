import { chromium } from "playwright"
import { spawn } from "node:child_process"

const ELECTRON = process.env.ELECTRON_PATH || "/Users/user/Developer/GitHub/Tribunus/node_modules/.bun/electron@41.2.1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
const MAIN = "out/main/index.js"

const electronProcess = spawn(ELECTRON, [MAIN], {
  stdio: "pipe",
  env: {
    ...process.env,
    OPENCODE_DB: ":memory:",
    TRIBUNUS_DB: ":memory:",
    TRIBUNUS_TEST_ONBOARDING: "1",
    TRIBUNUS_NO_UPDATE: "1",
    TRIBUNUS_CHANNEL: "dev",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
})

electronProcess.stderr.on("data", (d) => {
  const text = d.toString()
  if (!text.includes("IPC_METHOD_REGISTRY")) process.stderr.write(text)
})

async function main() {
  let wsUrl = ""
  const start = Date.now()
  while (Date.now() - start < 30_000) {
    try {
      const r = await fetch("http://127.0.0.1:9222/json/version")
      const data = await r.json()
      if (data.webSocketDebuggerUrl) { wsUrl = data.webSocketDebuggerUrl; break }
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  if (!wsUrl) { console.error("CDP not ready"); process.exit(1) }
  console.log("CDP browser WS:", wsUrl)

  try {
    const browser = await chromium.connectOverCDP(wsUrl, { noDefaults: true, timeout: 20_000 })
    console.log("Browser version:", browser.version())

    const pages = browser.contexts().flatMap(c => c.pages())
    console.log("Pages:", pages.length)
    for (const p of pages) {
      console.log("  Page:", await p.title(), "|", p.url())
      const body = await p.evaluate(() => document.body?.textContent?.slice(0, 100))
      console.log("  Body:", body)
    }

    await browser.close()
    console.log("OK — connectOverCDP+noDefaults works")
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("connectOverCDP failed:", msg.slice(0, 300))
  } finally {
    electronProcess.kill()
  }
}
await main()
