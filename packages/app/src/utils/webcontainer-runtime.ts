import { WebContainer } from "@webcontainer/api"
import type { TerminalRuntime, TerminalRuntimeSession, TerminalRuntimeStatus } from "./terminal-runtime"

let wcInstancePromise: Promise<WebContainer> | null = null

async function getWebContainer() {
  if (!wcInstancePromise) {
    wcInstancePromise = WebContainer.boot()
  }
  return wcInstancePromise
}

class WebContainerSession implements TerminalRuntimeSession {
  private wcProcess: any | null = null
  private writer: WritableStreamDefaultWriter<string> | null = null
  private disconnected = false
  private dataCallback: ((data: string) => void) | null = null

  constructor(public readonly id: string) {}

  async connect(options: {
    seek?: number
    onConnect?: () => void
    onConnectError?: (error: unknown) => void
    onData: (data: string) => void
    onCursorSeek?: (cursor: number) => void
    onDisconnect?: (err?: Error) => void
  }): Promise<void> {
    this.disconnected = false
    this.dataCallback = options.onData
    try {
      const wc = await getWebContainer()
      if (this.disconnected) return

      // We spawn `jsh` (the WebContainer shell)
      const proc = await wc.spawn("jsh", {
        terminal: {
          cols: 80,
          rows: 24,
        },
      })
      if (this.disconnected) {
        proc.kill()
        return
      }

      this.wcProcess = proc

      // Pipe output
      proc.output.pipeTo(
        new WritableStream({
          write: (data) => {
            if (this.disconnected) return
            this.dataCallback?.(data)
          },
        })
      )

      this.writer = proc.input.getWriter()
      options.onConnect?.()

      proc.exit.then((code) => {
        if (!this.disconnected) {
          options.onDisconnect?.()
        }
      })
    } catch (err) {
      options.onConnectError?.(err)
    }
  }

  write(data: string): void {
    if (this.writer) {
      this.writer.write(data).catch(console.error)
    }
  }

  resize(cols: number, rows: number): void | Promise<void> {
    if (this.wcProcess) {
      this.wcProcess.resize({ cols, rows })
    }
  }

  disconnect(): void {
    this.disconnected = true
    if (this.wcProcess) {
      this.wcProcess.kill()
      this.wcProcess = null
    }
    if (this.writer) {
      this.writer.releaseLock()
      this.writer = null
    }
  }

  async isGone(): Promise<boolean> {
    return false // WebContainer processes are re-created on connect, so the session conceptually lives on
  }
}

export class WebContainerRuntimeAdapter implements TerminalRuntime {
  readonly kind = "webcontainer"

  status(): TerminalRuntimeStatus {
    if (typeof window !== "undefined" && window.crossOriginIsolated) {
      return { ok: true, kind: "webcontainer" }
    }
    return { ok: false, kind: "unavailable", reason: "Requires cross-origin isolated context" }
  }

  getSession(id: string): TerminalRuntimeSession {
    return new WebContainerSession(id)
  }
}
