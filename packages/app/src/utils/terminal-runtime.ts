import type { LocalPTY } from "@/context/terminal"

export type TerminalRuntimeKind = "native-pty" | "webcontainer" | "wasm" | "remote" | "unavailable"

export type TerminalRuntimeStatus =
  | { ok: true; kind: TerminalRuntimeKind }
  | { ok: false; kind: "unavailable"; reason: string }

export interface TerminalRuntimeSession {
  readonly id: string

  /** 
   * Connect to the underlying process/stream. 
   * Provides callbacks to handle the stream lifecycle and data.
   */
  connect(options: {
    seek?: number
    onConnect?: () => void
    onConnectError?: (error: unknown) => void
    onData: (data: string) => void
    onCursorSeek?: (cursor: number) => void
    onDisconnect?: (err?: Error) => void
  }): void

  /** Send data to the terminal process */
  write(data: string): void

  /** Resize the terminal process */
  resize(cols: number, rows: number): void | Promise<void>

  /** Stop the transport (e.g. websocket close) but leave the session alive, for reconnection */
  disconnect(): void

  /** Check if the session process is gone from the runtime */
  isGone(): Promise<boolean>
}

export interface TerminalRuntime {
  readonly kind: TerminalRuntimeKind

  status(): TerminalRuntimeStatus

  /** 
   * Create or attach to a session stream for the given PTY.
   * Note: The creation of the PTY in the backend (if applicable) is still 
   * managed by the terminal context, this just returns the stream binding.
   */
  getSession(id: string): TerminalRuntimeSession
}
