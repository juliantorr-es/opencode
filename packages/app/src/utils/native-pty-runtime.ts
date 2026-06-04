import type { LocalPTY } from "@/context/terminal"
import type { TerminalRuntime, TerminalRuntimeSession, TerminalRuntimeStatus } from "./terminal-runtime"
import { terminalWebSocketURL } from "./terminal-websocket-url"

export interface NativePtyRuntimeDeps {
  client: any
  directory: string
  url: string
  sameOrigin: boolean
  username?: string
  password?: string
  authToken?: boolean
  language: any
}

const debugTerminal = (...values: unknown[]) => {
  if (!import.meta.env.DEV) return
  console.debug("[terminal]", ...values)
}

export class NativePtyRuntime implements TerminalRuntime {
  readonly kind = "native-pty"

  constructor(private readonly deps: NativePtyRuntimeDeps) {}

  status(): TerminalRuntimeStatus {
    return { ok: true, kind: "native-pty" }
  }

  getSession(id: string): TerminalRuntimeSession {
    return new NativePtySession(id, this.deps)
  }
}

class NativePtySession implements TerminalRuntimeSession {
  private ws: WebSocket | undefined
  private drop: VoidFunction | undefined
  private disposed = false
  private decoder = new TextDecoder()

  constructor(
    public readonly id: string,
    private readonly deps: NativePtyRuntimeDeps,
  ) {}

  connect(options: {
    seek?: number
    onConnect?: () => void
    onConnectError?: (error: unknown) => void
    onData: (data: string) => void
    onCursorSeek?: (cursor: number) => void
    onDisconnect?: (err?: Error) => void
  }): void {
    if (this.disposed) return
    this.drop?.()

    const { id, deps } = this

    const connectToken = async () => {
      const result = await deps.client.pty
        .connectToken(
          { ptyID: id, directory: deps.directory },
          {
            throwOnError: false,
            headers: { "x-opencode-ticket": "1" },
          },
        )
        .catch((err: unknown) => {
          if (err instanceof Error && err.message.includes("Request is not supported")) return
          throw err
        })
      if (!result) return
      if (result.response.status === 200 && result.data?.ticket) return result.data.ticket
      if (result.response.status === 404 || result.response.status === 405) return
      if (result.response.status === 403)
        throw new Error("PTY connect ticket rejected by origin or CSRF checks. Check the server CORS config.")
      throw new Error(`PTY connect ticket failed with ${result.response.status}`)
    }

    const open = async () => {
      if (this.disposed) return

      let errored = false
      const ticket = await connectToken().catch((err) => {
        errored = true
        options.onConnectError?.(err)
        return undefined
      })

      if (this.disposed || errored) return

      const socket = new WebSocket(
        terminalWebSocketURL({
          url: deps.url,
          id,
          directory: deps.directory,
          cursor: options.seek ?? 0,
          ticket,
          sameOrigin: deps.sameOrigin,
          username: deps.username,
          password: deps.password,
          authToken: deps.authToken,
        }),
      )
      socket.binaryType = "arraybuffer"
      this.ws = socket

      const handleOpen = () => {
        if (this.disposed) return
        options.onConnect?.()
      }

      const handleMessage = (event: MessageEvent) => {
        if (this.disposed) return
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data)
          if (bytes[0] !== 0) return
          const json = this.decoder.decode(bytes.subarray(1))
          try {
            const meta = JSON.parse(json) as { cursor?: unknown }
            const next = meta?.cursor
            if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
              options.onCursorSeek?.(next)
            }
          } catch (err) {
            debugTerminal("invalid websocket control frame", err)
          }
          return
        }

        const data = typeof event.data === "string" ? event.data : ""
        if (!data) return
        options.onData(data)
      }

      const handleError = (error: Event) => {
        if (this.disposed) return
        debugTerminal("websocket error", error)
      }

      const stop = () => {
        socket.removeEventListener("open", handleOpen)
        socket.removeEventListener("message", handleMessage)
        socket.removeEventListener("error", handleError)
        socket.removeEventListener("close", handleClose)
        if (this.ws === socket) this.ws = undefined
        if (this.drop === stop) this.drop = undefined
        if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
      }

      const handleClose = (event: CloseEvent) => {
        if (this.ws === socket) this.ws = undefined
        if (this.drop === stop) this.drop = undefined
        socket.removeEventListener("open", handleOpen)
        socket.removeEventListener("message", handleMessage)
        socket.removeEventListener("error", handleError)
        socket.removeEventListener("close", handleClose)
        if (this.disposed) return
        if (event.code === 1000) {
          options.onDisconnect?.()
          return
        }
        options.onDisconnect?.(new Error(deps.language.t("terminal.connectionLost.abnormalClose", { code: event.code })))
      }

      this.drop = stop
      socket.addEventListener("open", handleOpen)
      socket.addEventListener("message", handleMessage)
      socket.addEventListener("error", handleError)
      socket.addEventListener("close", handleClose)
    }

    void open()
  }

  write(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.deps.client.pty
      .update({
        ptyID: this.id,
        size: { cols, rows },
      })
      .catch((err: unknown) => {
        debugTerminal("failed to sync terminal size", err)
      })
  }

  disconnect(): void {
    this.drop?.()
  }

  async isGone(): Promise<boolean> {
    try {
      const result = await this.deps.client.pty.get({ ptyID: this.id }, { throwOnError: false })
      return result.response.status === 404
    } catch (err) {
      debugTerminal("failed to inspect terminal session", err)
      return false
    }
  }
}
