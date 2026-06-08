/**
 * Command Gateway — capability-scoped intents with idempotency keys.
 *
 * Each command intent carries a UUID-based idempotency key. The gateway
 * validates the intent against the granted capability set (from pairing),
 * tracks nonces for replay protection, queues commands when offline,
 * and dispatches via HTTP POST to the desktop's command endpoint.
 *
 * Queued commands are flushed when connectivity is restored.
 * Idempotency deduplication (max 500 keys) prevents replays.
 */

import { uuid } from "@/utils/uuid"

// ── Types ──────────────────────────────────────────────────────────────

/** The commands the mobile cockpit can issue. */
export type CockpitCommand =
  | "acknowledge_gate"
  | "approve_work"
  | "pause_agent"
  | "resume_agent"
  | "request_status"

/** A capability scope granted by the pairing handshake. */
export interface GrantedCapability {
  command: CockpitCommand
  /** Human-readable label shown in the cockpit UI. */
  label: string
  /** Optional lane or agent scope restriction. */
  scope?: string
}

export interface CommandIntent {
  id: string
  command: CockpitCommand
  target: {
    kind: "gate" | "agent" | "lane"
    id: string
  }
  payload?: Record<string, unknown>
  timestamp: number
}

export interface CommandResponse {
  accepted: boolean
  id: string
  /** Server-side reason if rejected. */
  reason?: string
}

/** A command queued for delivery when connectivity is restored. */
export interface QueuedCommand {
  id: string
  command: CockpitCommand
  target: CommandIntent["target"]
  payload?: Record<string, unknown>
  timestamp: number
  /** Number of times we attempted to flush this command. */
  retries: number
}

// ── Constants ──────────────────────────────────────────────────────────

const NONCE_STORAGE_KEY = "tribunus-pwa:command-nonces"
const MAX_NONCES = 500
const COMMAND_TIMEOUT_MS = 10_000
const QUEUE_STORAGE_KEY = "tribunus-pwa:command-queue"
const MAX_FLUSH_RETRIES = 3

// ── Implementation ─────────────────────────────────────────────────────

export interface CommandGateway {
  /** Replace the granted capability set (on pairing/re-pairing). */
  setCapabilities(caps: GrantedCapability[]): void
  /** The currently granted capabilities. */
  getCapabilities(): readonly GrantedCapability[]
  /** Whether a specific command is in the granted set. */
  canExecute(command: CockpitCommand): boolean
  /**
   * Execute a command. Returns the server response.
   * Throws if the capability is not granted or if the nonce has been replayed.
   * When offline, queues the command and returns an accepted response with
   * a "queued (offline)" reason. Queued commands flush on setOnline(true).
   */
  execute(
    command: CockpitCommand,
    target: CommandIntent["target"],
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CommandResponse>
  /** URL of the desktop command endpoint. Set during pairing. */
  setEndpoint(url: string): void
  /** Clear stored nonces — called on re-pairing. */
  resetNonces(): void
  /** Set online/offline status. Going online triggers a queue flush. */
  setOnline(online: boolean): void
  /** Current online/offline status. */
  readonly isOnline: boolean
  /** Peek at the queued commands (for UI display). */
  getQueuedCommands(): readonly QueuedCommand[]
  /** Number of commands currently queued. */
  readonly queueLength: number
}

interface NonceRecord {
  key: string
  consumedAt: number
}

function loadNonces(): NonceRecord[] {
  try {
    const raw = localStorage.getItem(NONCE_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as NonceRecord[]) : []
  } catch {
    return []
  }
}

function saveNonces(nonces: NonceRecord[]) {
  try {
    while (nonces.length > MAX_NONCES) nonces.shift()
    localStorage.setItem(NONCE_STORAGE_KEY, JSON.stringify(nonces))
  } catch {
    // Storage unavailable — degrade gracefully
  }
}

function loadQueue(): QueuedCommand[] {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as QueuedCommand[]) : []
  } catch {
    return []
  }
}

function saveQueue(queue: QueuedCommand[]) {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue))
  } catch {
    // Storage unavailable — degrade gracefully
  }
}

export function createCommandGateway(): CommandGateway {
  let capabilities: GrantedCapability[] = []
  let endpoint = ""
  let isOnline = true
  const consumedSet = new Set<string>()

  // Pre-load persisted nonces
  for (const r of loadNonces()) consumedSet.add(r.key)

  function persistNonces() {
    const records: NonceRecord[] = []
    for (const key of consumedSet) {
      records.push({ key, consumedAt: Date.now() })
    }
    saveNonces(records)
  }

  /** Send a single queued command. Returns true on success. */
  async function flushOne(cmd: QueuedCommand): Promise<boolean> {
    if (!endpoint) return false
    const intent: CommandIntent = {
      id: cmd.id,
      command: cmd.command,
      target: cmd.target,
      payload: cmd.payload,
      timestamp: cmd.timestamp,
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException("Flush timeout", "TimeoutError")), COMMAND_TIMEOUT_MS)
    try {
      const res = await fetch(`${endpoint}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
        signal: controller.signal,
      })
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** Attempt to send all queued commands. Removes successful ones. */
  async function flushQueue() {
    const queue = loadQueue()
    if (queue.length === 0) return

    const remaining: QueuedCommand[] = []
    for (const cmd of queue) {
      if (cmd.retries >= MAX_FLUSH_RETRIES) {
        // Give up after max retries — leave in queue for manual review
        remaining.push(cmd)
        continue
      }
      const ok = await flushOne({ ...cmd, retries: cmd.retries + 1 })
      if (!ok) remaining.push({ ...cmd, retries: cmd.retries + 1 })
    }
    saveQueue(remaining)
  }

  return {
    setCapabilities(caps) {
      capabilities = caps
    },

    getCapabilities() {
      return capabilities
    },

    canExecute(command) {
      return capabilities.some((c) => c.command === command)
    },

    get isOnline() {
      return isOnline
    },

    get queueLength() {
      return loadQueue().length
    },

    getQueuedCommands() {
      return loadQueue()
    },

    setOnline(online: boolean) {
      const wasOffline = !isOnline
      isOnline = online
      if (online && wasOffline) {
        // Flush queue when transitioning from offline → online
        flushQueue()
      }
    },

    async execute(command, target, payload, signal) {
      if (!endpoint) throw new Error("CommandGateway: no endpoint configured — pair with a desktop first")

      if (!capabilities.some((c) => c.command === command)) {
        throw new Error(`CommandGateway: capability "${command}" not granted by pairing`)
      }

      const id = uuid()
      const timestamp = Date.now()

      // Replay protection: check if this idempotency key has been consumed
      if (consumedSet.has(id)) {
        throw new Error(`CommandGateway: idempotency key "${id}" already consumed — possible replay`)
      }
      consumedSet.add(id)
      persistNonces()

      // ── Offline: queue instead of sending ──────────────
      if (!isOnline) {
        const queue = loadQueue()
        queue.push({ id, command, target, payload, timestamp, retries: 0 })
        saveQueue(queue)
        return { accepted: true, id, reason: "queued (offline)" }
      }

      // ── Online: send via HTTP ─────────────────────────
      const intent: CommandIntent = { id, command, target, payload, timestamp }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new DOMException("Command timeout", "TimeoutError")), COMMAND_TIMEOUT_MS)

      // Merge external signal
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
      }

      try {
        const res = await fetch(`${endpoint}/command`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(intent),
          signal: controller.signal,
        })

        if (!res.ok) {
          const text = await res.text().catch(() => "unknown")
          return { accepted: false, id, reason: `HTTP ${res.status}: ${text}` }
        }

        const response = (await res.json()) as CommandResponse
        return response
      } finally {
        clearTimeout(timer)
      }
    },

    setEndpoint(url) {
      endpoint = url.replace(/\/+$/, "")
    },

    resetNonces() {
      consumedSet.clear()
      try {
        localStorage.removeItem(NONCE_STORAGE_KEY)
      } catch {
        // noop
      }
    },
  }
}

export const commandGateway = createCommandGateway()
