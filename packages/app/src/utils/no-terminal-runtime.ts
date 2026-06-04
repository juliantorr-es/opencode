import type { LocalPTY } from "@/context/terminal"
import type { TerminalRuntime, TerminalRuntimeSession, TerminalRuntimeStatus } from "./terminal-runtime"

export class NoTerminalRuntime implements TerminalRuntime {
  readonly kind = "unavailable"

  status(): TerminalRuntimeStatus {
    return { ok: false, kind: "unavailable", reason: "No terminal runtime is configured for browser mode." }
  }

  getSession(id: string): TerminalRuntimeSession {
    return new NoTerminalSession(id)
  }
}

class NoTerminalSession implements TerminalRuntimeSession {
  constructor(public readonly id: string) {}

  connect(options: {
    seek?: number
    onConnect?: () => void
    onConnectError?: (error: unknown) => void
    onData: (data: string) => void
    onCursorSeek?: (cursor: number) => void
    onDisconnect?: (err?: Error) => void
  }): void {
    setTimeout(() => {
      options.onConnectError?.(new Error("No terminal runtime is configured for browser mode."))
    }, 0)
  }

  write(data: string): void {
    // no-op
  }

  resize(cols: number, rows: number): Promise<void> {
    return Promise.resolve()
  }

  disconnect(): void {
    // no-op
  }

  async isGone(): Promise<boolean> {
    return true
  }
}
