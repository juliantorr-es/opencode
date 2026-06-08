/**
 * Isolated extension host process for @tribunus/plugin trust kernel.
 *
 * Each plugin runs in its own Bun subprocess with a restricted environment.
 * The host mediates all communication through a capability-scoped handle,
 * enforcing the confinement policy on every invocation before forwarding
 * to the plugin process. Crashes trigger automatic restart with exponential
 * backoff, and all lifecycle transitions produce audit receipts.
 *
 * @module
 */

import crypto from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { type PluginManifest } from "./manifest.js"
import {
  type ConfinementPolicy,
  DEFAULT_CONFINEMENT,
  validateAgainstConfinement,
} from "./confinement.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExtensionHostOptions {
  /** Unique plugin identifier (matches PluginManifest.id). */
  pluginId: string
  /** The plugin's declared manifest (used to scope capability checks). */
  manifest: PluginManifest
  /** Absolute path to the plugin entry file (the subprocess's main module). */
  entryPoint: string
  /** Capability names that were granted by the governance pipeline. */
  grantedCapabilities: string[]
  /** Confinement policy to enforce on every capability invocation.
   *  Defaults to `DEFAULT_CONFINEMENT` when omitted. */
  confinement?: ConfinementPolicy
}

// ---------------------------------------------------------------------------
// Message protocol
// ---------------------------------------------------------------------------

/**
 * A message exchanged between the extension host and the plugin subprocess.
 *
 * Messages flow over stdin/stdout as newline-delimited JSON. The `id` field
 * enables request-response correlation for capability invocations.
 */
export interface ExtensionHostMessage {
  /** Message kind. */
  type: "invoke" | "response" | "error" | "lifecycle"
  /** Unique message identifier (used for request-response correlation). */
  id: string
  /** Canonical capability name being invoked (present on "invoke" messages). */
  capability?: string
  /** Arbitrary payload (function arguments, return values, error details). */
  payload?: unknown
  /** ISO 8601 timestamp of when the message was created. */
  timestamp: string
}

// ---------------------------------------------------------------------------
// Audit receipt
// ---------------------------------------------------------------------------

/**
 * An audit receipt for an extension host lifecycle event.
 *
 * Every transition (start, stop, crash, restart) generates a receipt
 * so the governance subsystem can produce an audit trail.
 */
export interface AuditReceipt {
  receiptId: string
  pluginId: string
  event: "started" | "stopped" | "crashed" | "restarted"
  previousStatus: string
  newStatus: string
  retryCount?: number
  timestamp: string
}

// ---------------------------------------------------------------------------
// ExtensionHost interface
// ---------------------------------------------------------------------------

/**
 * Lifecycle handle for an isolated extension host subprocess.
 *
 * Callers create one host per plugin, feed it granted capabilities,
 * and communicate with the plugin through the `send`/`onMessage` pair.
 * Every capability message is gated through the confinement policy.
 */
export interface ExtensionHost {
  /** The plugin this host manages. */
  readonly pluginId: string
  /** Current lifecycle status. */
  readonly status: "starting" | "running" | "stopped" | "crashed"

  /** Start the subprocess and begin accepting messages. */
  start(): Promise<void>
  /** Gracefully stop the subprocess. */
  stop(): Promise<void>
  /** Send a message to the plugin subprocess (confinement-enforced). */
  send(message: Omit<ExtensionHostMessage, "timestamp">): Promise<void>
  /** Register a handler for messages from the plugin subprocess.
   *  Returns an unsubscribe function. */
  onMessage(handler: (msg: ExtensionHostMessage) => void): () => void
  /** Restart the subprocess (stop + start with backoff reset). */
  restart(): Promise<void>
}

// ---------------------------------------------------------------------------
// Backoff constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000
const BACKOFF_MULTIPLIER = 2

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default implementation of ExtensionHost.
 *
 * Architecture:
 * - Spawns the plugin entry point as a Bun child process via `Bun.spawn`.
 * - Communicates over stdin (host→plugin) / stdout (plugin→host) using
 *   newline-delimited JSON (NDJSON).
 * - Every outgoing `invoke` message is checked against the confinement policy;
 *   disallowed invocations produce an `error` response without touching the
 *   subprocess.
 * - Subprocess crashes trigger automatic restart with exponential backoff
 *   (500 ms → 30 s max, 2× multiplier).
 * - All lifecycle transitions emit a receipt string for the audit trail.
 *
 * @internal
 */
export class HostImpl implements ExtensionHost {
  readonly pluginId: string
  readonly #options: ExtensionHostOptions
  readonly #confinement: ConfinementPolicy

  #proc: ChildProcess | null = null
  #status: "starting" | "running" | "stopped" | "crashed" = "stopped"
  #handlers = new Set<(msg: ExtensionHostMessage) => void>()
  #retryCount = 0
  #backoffMs = INITIAL_BACKOFF_MS
  #disposed = false
  #buffer = "" // partial line accumulator
  #startPromise: Promise<void> | null = null

  constructor(options: ExtensionHostOptions) {
    this.pluginId = options.pluginId
    this.#options = options
    this.#confinement = options.confinement ?? DEFAULT_CONFINEMENT
  }

  // ── Status ───────────────────────────────────────────────────

  get status(): "starting" | "running" | "stopped" | "crashed" {
    return this.#status
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.#disposed) throw new Error("Host has been disposed")
    if (this.#status === "running" || this.#status === "starting") return

    this.#status = "starting"
    this.#startPromise = this.#doStart()
    await this.#startPromise
  }

  async stop(): Promise<void> {
    if (this.#disposed) return
    if (this.#status === "stopped") return

    // Wait for any in-flight start to complete.
    if (this.#startPromise) await this.#startPromise

    const previous = this.#status
    this.#status = "stopped"
    this.#retryCount = 0
    this.#backoffMs = INITIAL_BACKOFF_MS

    const proc = this.#proc
    if (proc && !proc.killed) {
      // Send graceful shutdown signal.
      proc.kill("SIGTERM")
      // Give the subprocess a short grace period, then SIGKILL.
      const killTimer = setTimeout(() => {
        if (proc && !proc.killed) proc.kill("SIGKILL")
      }, 2_000)
      // Wait for the process to exit.
      await new Promise<void>((resolve) => {
        proc.on("exit", () => {
          clearTimeout(killTimer)
          resolve()
        })
      })
    }

    this.#proc = null
    this.#emitReceipt({ event: "stopped", previousStatus: previous, newStatus: "stopped" })
  }

  async restart(): Promise<void> {
    if (this.#disposed) return
    await this.stop()
    await this.start()
  }

  // ── Messaging ────────────────────────────────────────────────

  async send(message: Omit<ExtensionHostMessage, "timestamp">): Promise<void> {
    if (this.#disposed) throw new Error("Host has been disposed")
    if (this.#status !== "running") throw new Error(`Cannot send message in status: ${this.#status}`)

    // Confinement enforcement — gate every invoke message.
    if (message.type === "invoke" && message.capability) {
      const policy = this.#confinement
      // 1. Ensure the capability was granted by governance.
      if (!this.#options.grantedCapabilities.includes(message.capability)) {
        this.#dispatchToHandlers(this.#makeErrorMessage(message.id, `Capability "${message.capability}" was not granted`))
        return
      }
      // 2. Validate against confinement policy.
      const result = validateAgainstConfinement(message.capability, policy)
      if (!result.allowed) {
        this.#dispatchToHandlers(
          this.#makeErrorMessage(message.id, `Capability "${message.capability}" denied by confinement: ${result.reason}`),
        )
        return
      }
    }

    // Forward to subprocess.
    const framed = JSON.stringify({ ...message, timestamp: new Date().toISOString() }) + "\n"
    if (this.#proc?.stdin?.writable) {
      this.#proc.stdin.write(framed)
    }
  }

  onMessage(handler: (msg: ExtensionHostMessage) => void): () => void {
    this.#handlers.add(handler)
    return () => {
      this.#handlers.delete(handler)
    }
  }

  // ── Internal: subprocess management ──────────────────────────

  async #doStart(): Promise<void> {
    const entryPoint = this.#options.entryPoint
    const previousStatus = this.#status

    return new Promise<void>((resolve, reject) => {
      try {
        // Spawn the plugin entry point as a child process.
        // Use `bun run` when the entry point is a file, or spawn it directly.
        // Build the subprocess environment.
        // When denySecrets is active, only forward a minimal safe set of
        // environment variables (PATH, HOME, TMPDIR, and the Tribunus
        // runtime vars) to prevent credential leakage.
        const baseEnv = this.#confinement.denySecrets
          ? filterSafeEnv(process.env as Record<string, string>)
          : { ...process.env }
        const proc = spawn(entryPoint, [], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...baseEnv,
            TRIBUNUS_PLUGIN_ID: this.pluginId,
            TRIBUNUS_PLUGIN_MODE: "extension_host",
          },
        })

        this.#proc = proc

        // Collect stdout data — newline-delimited JSON from the plugin.
        proc.stdout!.on("data", (chunk: Buffer) => {
          this.#buffer += chunk.toString()
          this.#flushBuffer()
        })

        // Collect stderr for diagnostics.
        proc.stderr!.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim()
          if (text) {
            this.#dispatchToHandlers({
              type: "error",
              id: crypto.randomUUID(),
              capability: undefined,
              payload: { stream: "stderr", text },
              timestamp: new Date().toISOString(),
            })
          }
        })

        // Handle exit / crash.
        proc.on("exit", (code, signal) => {
          if (this.#disposed || this.#status === "stopped") return

          const crashed = code !== 0 || (signal !== null && signal !== "SIGTERM")
          if (crashed) {
            this.#status = "crashed"
            this.#emitReceipt({
              event: "crashed",
              previousStatus: "running",
              newStatus: "crashed",
            })
            this.#handleCrash()
          }
        })

        proc.on("error", (err) => {
          if (this.#disposed) return
          this.#status = "crashed"
          this.#emitReceipt({
            event: "crashed",
            previousStatus: previousStatus,
            newStatus: "crashed",
          })
          this.#handleCrash()
          reject(err)
        })

        // Mark as running once the process is ready.
        this.#status = "running"
        this.#emitReceipt({
          event: "started",
          previousStatus: previousStatus,
          newStatus: "running",
        })
        resolve()
      } catch (err) {
        this.#status = "crashed"
        reject(err)
      }
    })
  }

  #handleCrash(): void {
    if (this.#disposed) return
    if (this.#status !== "crashed") return

    this.#proc = null
    this.#retryCount++

    // Exponential backoff with ceiling.
    const delay = Math.min(this.#backoffMs, MAX_BACKOFF_MS)
    this.#backoffMs = Math.min(this.#backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS)

    // Schedule restart.
    setTimeout(() => {
      if (this.#disposed || this.#status !== "crashed") return
      this.#doStart().catch(() => {
        // #doStart will set status to "crashed" on failure;
        // #handleCrash recurses.
      })
    }, delay)

    this.#emitReceipt({
      event: "restarted",
      previousStatus: "crashed",
      newStatus: "starting",
      retryCount: this.#retryCount,
    })
  }

  // ── Internal: message dispatching ────────────────────────────

  #flushBuffer(): void {
    const lines = this.#buffer.split("\n")
    // Keep the last (possibly incomplete) segment in the buffer.
    this.#buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed) as ExtensionHostMessage
        this.#dispatchToHandlers(msg)
      } catch {
        // Malformed JSON from the subprocess — discard silently.
      }
    }
  }

  #dispatchToHandlers(msg: ExtensionHostMessage): void {
    for (const handler of this.#handlers) {
      try {
        handler(msg)
      } catch {
        // Handler error — swallow to avoid crashing the host loop.
      }
    }
  }

  #makeErrorMessage(id: string, text: string): ExtensionHostMessage {
    return {
      type: "error",
      id,
      payload: { error: text },
      timestamp: new Date().toISOString(),
    }
  }

  // ── Audit receipts ───────────────────────────────────────────

  #emitReceipt(event: {
    event: "started" | "stopped" | "crashed" | "restarted"
    previousStatus: string
    newStatus: string
    retryCount?: number
  }): void {
    const receipt: AuditReceipt = {
      receiptId: crypto.randomUUID(),
      pluginId: this.pluginId,
      event: event.event,
      previousStatus: event.previousStatus,
      newStatus: event.newStatus,
      timestamp: new Date().toISOString(),
    }
    if (event.retryCount !== undefined) {
      receipt.retryCount = event.retryCount
    }
    // Dispatch the receipt as a lifecycle message so subscribers can
    // forward it to the audit subsystem.
    this.#dispatchToHandlers({
      type: "lifecycle",
      id: receipt.receiptId,
      payload: receipt,
      timestamp: receipt.timestamp,
    })
  }
}

// ── Environment filtering ─────────────────────────────────────

/** Safe environment variable names that do not carry secrets. */
const SAFE_ENV_KEYS: Record<string, true> = {
  PATH: true,
  HOME: true,
  TMPDIR: true,
  TEMP: true,
  TMP: true,
  USER: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  SHELL: true,
  TERM: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_CACHE_HOME: true,
  XDG_RUNTIME_DIR: true,
}

/**
 * Strip all environment variables except a safe set of non-secret ones.
 *
 * Used when `denySecrets` is active to prevent credential leakage into
 * the plugin subprocess.
 */
function filterSafeEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    if (SAFE_ENV_KEYS[key]) {
      result[key] = env[key]
    }
  }
  return result
}
