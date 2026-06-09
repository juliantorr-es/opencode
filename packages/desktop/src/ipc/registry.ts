import { Schema } from "effect"
import type { IpcErrorCode as IpcErrorCodeType } from "./errors"

/** Sensitivity classification for sender policy and logging */
export type Sensitivity = "public" | "internal" | "secret" | "authority"

/** Timeout policy */
export type TimeoutPolicy = "none" | "short" | "standard" | "long"

/** Sender policy */
export type SenderPolicy = "standard" | "strict"

/** Category for grouping */
export type Category =
  | "init" | "config" | "store" | "fs" | "window" | "session" | "locale"
  | "github" | "secrets" | "notifications" | "git" | "capabilities"
  | "plugin" | "safe-mode" | "coordination"

/** IPC error code */
export type IpcErrorCode = IpcErrorCodeType

/** Invoke method contract — the single source of truth for each invoke channel */
export interface IpcMethodContract {
  readonly channel: string
  readonly method: string
  readonly params: Schema.Schema<any>
  readonly success: Schema.Schema<any>
  readonly category: Category
  readonly timeout: TimeoutPolicy
  readonly sensitivity: Sensitivity
  readonly senderPolicy: SenderPolicy
  readonly errors: readonly string[]
  readonly description: string
}

/** Send method contract */
export interface IpcSendDef {
  readonly channel: string
  readonly method: string
  readonly params: Schema.Schema<any>
  readonly category: Category
  readonly description: string
}

/** Aggregate registry — collects all domain contracts */
export class IpcContractRegistry {
  readonly invokes: Map<string, IpcMethodContract> = new Map()
  readonly sends: Map<string, IpcSendDef> = new Map()

  registerInvoke(...contracts: readonly IpcMethodContract[]): this {
    for (const c of contracts) {
      if (this.invokes.has(c.method)) throw new Error(`Duplicate invoke method: ${c.method}`)
      if (this.invokes.has(c.channel)) throw new Error(`Duplicate invoke channel: ${c.channel}`)
      this.invokes.set(c.method, c)
      this.invokes.set(c.channel, c)
    }
    return this
  }

  registerSend(...defs: readonly IpcSendDef[]): this {
    for (const d of defs) {
      if (this.sends.has(d.channel)) throw new Error(`Duplicate send channel: ${d.channel}`)
      this.sends.set(d.channel, d)
    }
    return this
  }
}
