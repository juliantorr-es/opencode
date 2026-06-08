import crypto from "node:crypto"

// ── Types ──────────────────────────────────────────────────

export type RevocationTarget =
  | { type: "package"; packageId: string }
  | { type: "publisher"; publisherKey: string }
  | { type: "signing_key"; keyId: string }
  | { type: "version"; packageId: string; version: string }
  | { type: "capability"; pluginId: string; capability: string }
  | { type: "agent_invocation"; agentId: string }
  | { type: "network_access"; pluginId: string }
  | { type: "secrets_access"; pluginId: string }

export type RevocationMode = "immediate" | "graceful" | "cascade"

export interface RevocationOrder {
  orderId: string
  target: RevocationTarget
  mode: RevocationMode
  reason: string
  issuer: string
  timestamp: string
  expiresAt?: string
}

export interface RevocationReceipt {
  receiptId: string
  orderId: string
  target: RevocationTarget
  mode: RevocationMode
  outcome: "applied" | "pending" | "failed"
  affectedPlugins: string[]
  fanoutChannels: string[]
  timestamp: string
}

export interface RevocationService {
  /** Issue a revocation order and fan out via Valkey Pub/Sub */
  revoke(order: Omit<RevocationOrder, "orderId" | "timestamp">): Promise<RevocationReceipt>

  /** Check if a plugin/capability is currently revoked */
  isRevoked(target: RevocationTarget): Promise<boolean>

  /** List active revocations for auditing */
  listActiveRevocations(filter?: { pluginId?: string; publisherKey?: string }): Promise<RevocationOrder[]>

  /** Lift a revocation (un-revoke) */
  restore(orderId: string): Promise<RevocationReceipt>
}

// ── Pub/Sub Abstraction ────────────────────────────────────
// Exposed so callers can wire a Valkey-backed implementation
// (e.g. via CoordinationFabric.publish / subscribe) without
// the plugin package depending on ioredis directly.

export interface RevocationEvent {
  type: "revoked" | "restored"
  order: RevocationOrder
  receipt: RevocationReceipt
}

export interface RevocationPubSub {
  publish(event: RevocationEvent, channels: string[]): Promise<void>
  subscribe(channel: string, handler: (event: RevocationEvent) => void): Promise<() => void>
}

/** In-memory pub/sub stub. Used when no Valkey fabric is wired. */
export class LocalRevocationPubSub implements RevocationPubSub {
  private handlers = new Map<string, Set<(event: RevocationEvent) => void>>()

  async publish(event: RevocationEvent, channels: string[]): Promise<void> {
    for (const channel of channels) {
      const handlers = this.handlers.get(channel)
      if (handlers) {
        for (const handler of handlers) {
          handler(event)
        }
      }
    }
  }

  async subscribe(channel: string, handler: (event: RevocationEvent) => void): Promise<() => void> {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set())
    }
    this.handlers.get(channel)!.add(handler)
    return () => {
      this.handlers.get(channel)?.delete(handler)
    }
  }
}

// ── Options ─────────────────────────────────────────────────

export interface RevocationServiceOptions {
  pubSub?: RevocationPubSub
  /** Grace period in milliseconds (default 24h) */
  gracePeriodMs?: number
}

// ── Implementation ─────────────────────────────────────────

const DEFAULT_GRACE_PERIOD_MS = 86_400_000 // 24 hours
const SWEEP_INTERVAL_MS = 30_000

export class RevocationServiceImpl implements RevocationService {
  private orders = new Map<string, RevocationOrder>()
  private receipts = new Map<string, RevocationReceipt>()
  private revokedKeys = new Set<string>()
  private pubSub: RevocationPubSub
  private gracePeriodMs: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts?: RevocationServiceOptions) {
    this.pubSub = opts?.pubSub ?? new LocalRevocationPubSub()
    this.gracePeriodMs = opts?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS)
  }

  async revoke(partial: Omit<RevocationOrder, "orderId" | "timestamp">): Promise<RevocationReceipt> {
    const orderId = crypto.randomUUID()
    const now = new Date()
    const timestamp = now.toISOString()

    const expiresAt =
      partial.mode === "graceful"
        ? new Date(now.getTime() + this.gracePeriodMs).toISOString()
        : undefined

    const order: RevocationOrder = {
      ...partial,
      orderId,
      timestamp,
      expiresAt,
    }

    const affectedPlugins = this.collectAffectedPlugins(order.target)
    const fanoutChannels = this.buildFanoutChannels(order.target, affectedPlugins)

    let outcome: RevocationReceipt["outcome"]

    switch (order.mode) {
      case "immediate":
        this.applyRevocation(order)
        outcome = "applied"
        break

      case "graceful":
        this.orders.set(orderId, order)
        outcome = "pending"
        break

      case "cascade":
        this.applyRevocation(order)
        for (const pluginId of affectedPlugins) {
          const cascadeOrder: RevocationOrder = {
            ...partial,
            orderId: crypto.randomUUID(),
            timestamp: now.toISOString(),
            target: { type: "package", packageId: pluginId },
          }
          this.applyRevocation(cascadeOrder)
        }
        outcome = "applied"
        break
    }

    const receipt: RevocationReceipt = {
      receiptId: crypto.randomUUID(),
      orderId,
      target: order.target,
      mode: order.mode,
      outcome,
      affectedPlugins,
      fanoutChannels,
      timestamp: now.toISOString(),
    }

    this.receipts.set(receipt.receiptId, receipt)

    const event: RevocationEvent = { type: "revoked", order, receipt }
    await this.pubSub.publish(event, fanoutChannels)

    return receipt
  }

  async isRevoked(target: RevocationTarget): Promise<boolean> {
    const key = this.targetKey(target)
    if (this.revokedKeys.has(key)) return true

    // Check broad revocations that encompass this target
    for (const order of this.orders.values()) {
      if (!this.isActive(order)) continue

      // Package revocation covers all versions of that package
      if (order.target.type === "package" && target.type === "version") {
        if (order.target.packageId === target.packageId) return true
      }

      // Publisher/capability/signing-key resolution would need a
      // registry lookup in production; stub skips those.
    }

    return false
  }

  async listActiveRevocations(filter?: { pluginId?: string; publisherKey?: string }): Promise<RevocationOrder[]> {
    const active: RevocationOrder[] = []

    for (const order of this.orders.values()) {
      if (!this.isActive(order)) continue

      if (filter) {
        if (filter.pluginId) {
          const t = order.target
          const matchesPlugin =
            ((t.type === "package" || t.type === "version") && t.packageId === filter.pluginId) ||
            ((t.type === "capability" || t.type === "network_access" || t.type === "secrets_access") && t.pluginId === filter.pluginId)
          if (!matchesPlugin) continue
        }
        if (filter.publisherKey) {
          if (!(order.target.type === "publisher" && order.target.publisherKey === filter.publisherKey)) continue
        }
      }

      active.push(order)
    }

    return active
  }

  async restore(orderId: string): Promise<RevocationReceipt> {
    const order = this.orders.get(orderId)
    if (!order) {
      return {
        receiptId: crypto.randomUUID(),
        orderId,
        target: { type: "package", packageId: "unknown" },
        mode: "immediate",
        outcome: "failed",
        affectedPlugins: [],
        fanoutChannels: [],
        timestamp: new Date().toISOString(),
      }
    }

    const targetKey = this.targetKey(order.target)
    this.revokedKeys.delete(targetKey)
    this.orders.delete(orderId)

    const affectedPlugins = this.collectAffectedPlugins(order.target)
    const fanoutChannels = this.buildFanoutChannels(order.target, affectedPlugins)

    const receipt: RevocationReceipt = {
      receiptId: crypto.randomUUID(),
      orderId,
      target: order.target,
      mode: order.mode,
      outcome: "applied",
      affectedPlugins,
      fanoutChannels,
      timestamp: new Date().toISOString(),
    }

    this.receipts.set(receipt.receiptId, receipt)

    const event: RevocationEvent = { type: "restored", order, receipt }
    await this.pubSub.publish(event, fanoutChannels)

    return receipt
  }

  /** Release background timer. Call during shutdown. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  // ── Internals ────────────────────────────────────────────

  private applyRevocation(order: RevocationOrder): void {
    const key = this.targetKey(order.target)
    this.revokedKeys.add(key)
    this.orders.set(order.orderId, order)
  }

  private isActive(order: RevocationOrder): boolean {
    // Graceful — only active once expired
    if (order.mode === "graceful" && order.expiresAt) {
      if (new Date(order.expiresAt) > new Date()) return false
    }

    // Must still be in the revoked set (not restored)
    return this.revokedKeys.has(this.targetKey(order.target))
  }

  private targetKey(target: RevocationTarget): string {
    switch (target.type) {
      case "package":
        return `package:${target.packageId}`
      case "publisher":
        return `publisher:${target.publisherKey}`
      case "signing_key":
        return `signing_key:${target.keyId}`
      case "version":
        return `version:${target.packageId}:${target.version}`
      case "capability":
        return `capability:${target.pluginId}:${target.capability}`
      case "agent_invocation":
        return `agent_invocation:${target.agentId}`
      case "network_access":
        return `network_access:${target.pluginId}`
      case "secrets_access":
        return `secrets_access:${target.pluginId}`
    }
  }

  private collectAffectedPlugins(target: RevocationTarget): string[] {
    // Production would query the plugin registry to resolve the full
    // dependency graph.  Here we return what we can derive from the target.
    switch (target.type) {
      case "capability":
      case "network_access":
      case "secrets_access":
        return [target.pluginId]
      case "agent_invocation":
        return [target.agentId]
      case "package":
      case "version":
        return []
      case "publisher":
      case "signing_key":
        return []
    }
  }

  private buildFanoutChannels(target: RevocationTarget, affectedPlugins: string[]): string[] {
    const channels = ["tribunus:revocations"]

    for (const pluginId of affectedPlugins) {
      channels.push(`tribunus:plugins:${pluginId}:revoked`)
    }

    if (target.type === "package") {
      channels.push(`tribunus:plugins:${target.packageId}:revoked`)
    }

    return [...new Set(channels)]
  }

  private sweepExpired(): void {
    const now = new Date()
    for (const [orderId, order] of this.orders) {
      if (order.mode !== "graceful" || !order.expiresAt) continue
      if (new Date(order.expiresAt) <= now) {
        this.applyRevocation(order)
      }
    }
  }
}
