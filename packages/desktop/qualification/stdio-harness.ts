import { spawn, type ChildProcess } from "node:child_process"
import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"

export interface DriverResponse {
  ok: boolean
  id: string
  result?: unknown
  error?: { code: string; message: string }
}

export class QualificationHarness {
  readonly #proc: ChildProcess
  readonly #tempDir: string
  #nextId = 0
  #pending = new Map<string, { resolve: (r: DriverResponse) => void; reject: (e: Error) => void }>()

  constructor(tempDir: string, electronPath: string, mainEntry: string, extraEnv: Record<string, string | undefined> = {}) {
    this.#tempDir = tempDir
    this.#proc = spawn(electronPath, [mainEntry], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        TRIBUNUS_QUALIFICATION_DRIVER: "1",
        OPENCODE_HOME: tempDir,
        OPENCODE_DB: ":memory:",
        OPENCODE_DB: join(tempDir, "opencode.db"),
        TRIBUNUS_DB: join(tempDir, "tribunus.db"),
        TRIBUNUS_TEST_ONBOARDING: "1",
        TRIBUNUS_NO_UPDATE: "1",
        TRIBUNUS_CHANNEL: "dev",
        OPENCODE_CHANNEL: "dev",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        ...Object.fromEntries(Object.entries(extraEnv).filter(([, v]) => v !== undefined)),
      },
    })

    this.#proc.on("message", (msg: unknown) => {
      const m = msg as DriverResponse
      const pending = this.#pending.get(m.id)
      if (pending) {
        this.#pending.delete(m.id)
        pending.resolve(m)
      }
    })

    this.#proc.on("exit", (code) => {
      const err = new Error(`Electron exited with code ${code}`)
      for (const [, p] of this.#pending) p.reject(err)
      this.#pending.clear()
    })
  }

  async send(command: string, params: Record<string, unknown> = {}): Promise<DriverResponse> {
    const id = String(++this.#nextId)
    const { promise, resolve, reject } = Promise.withResolvers<DriverResponse>()
    this.#pending.set(id, { resolve, reject })

    const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<DriverResponse>()
    const timer = setTimeout(() => timeoutResolve({ ok: false, id, error: { code: "timeout", message: "Command timed out" } }), 30_000)

    this.#proc.send({ id, command, params })

    const result = await Promise.race([promise, timeoutPromise])
    clearTimeout(timer)
    this.#pending.delete(id)
    return result
  }

  async waitForReady(timeoutMs = 30_000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const r = await this.send("app.ready")
      if (r.ok && r.result && (r.result as Record<string, unknown>).ready === true) return true
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 500)
      await promise
    }
    return false
  }

  async waitForWindow(timeoutMs = 30_000): Promise<DriverResponse> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const r = await this.send("window.list")
      if (r.ok && r.result && (r.result as { count: number }).count > 0) return r
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 1000)
      await promise
    }
    return { ok: false, id: "timeout", error: { code: "timeout", message: "No window appeared" } }
  }

  async execInRenderer(code: string): Promise<DriverResponse> {
    return this.send("renderer.execute", { code })
  }

  async invokeApi(method: string, args: unknown[]): Promise<DriverResponse> {
    return this.send("renderer.invokeApi", { method, args })
  }

  async screenshot(filename: string): Promise<DriverResponse> {
    return this.send("window.screenshot", { filename })
  }

  async quit(): Promise<void> {
    await this.send("app.quit")
    this.#proc.kill()
  }

  get tempDir(): string { return this.#tempDir }
  get pid(): number | undefined { return this.#proc.pid }
}
