import { Effect } from "effect"
import { IPC } from "./ipc-channels"
import { registerIpcEffectHandler } from "./ipc-adapter"
import type { DesktopRuntime } from "./effect/desktop-runtime"
import { getStore } from "./store"
import {
  ReservedNamespaceError,
  InvalidNamespaceError,
  InvalidKeyError,
  StorePersistenceError,
  StoreUnavailableError,
  mapStoreError,
} from "./errors/store-errors"

// Schemas — imported from the contract definitions for decode/encode
import * as S from "../ipc/schema-compat"
const StoreGetParams = S.Tuple([S.Str, S.Str])
const StoreSetParams = S.Tuple([S.Str, S.Str, S.Unknown])
const StoreDeleteParams = S.Tuple([S.Str, S.Str])
const StoreClearParams = S.Tuple([S.Str])
const StoreKeysParams = S.Tuple([S.Str])
const StoreLengthParams = S.Tuple([S.Str])
const StoreGetSuccess = S.Nullable(S.Str)
const StoreSetSuccess = S.UndefinedConst
const StoreDeleteSuccess = S.UndefinedConst
const StoreClearSuccess = S.UndefinedConst
const StoreKeysSuccess = S.Arr(S.Str)
const StoreLengthSuccess = S.Num

const RESERVED_STORE_NAMES: readonly string[] = [
  IPC.store.DESKTOP_CUSTOM_AGENTS,
  IPC.store.DESKTOP_MCP_SERVERS,
  IPC.store.DESKTOP_PLUGIN_CONFIG,
  IPC.store.GITHUB_AUTH,
]

function checkReserved(name: string): void {
  if (RESERVED_STORE_NAMES.includes(name)) {
    throw new ReservedNamespaceError(name)
  }
}

function checkNamespace(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidNamespaceError(name)
  }
}

function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidKeyError(key)
  }
}

function checkStoreAvailable(name: string) {
  try {
    return getStore(name)
  } catch {
    throw new StoreUnavailableError()
  }
}

export function registerStoreIpcHandlers(runtime: DesktopRuntime) {
  // ── STORE_GET ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.STORE_GET,
    params: StoreGetParams,
    success: StoreGetSuccess,
    timeout: 5_000,
    senderPolicy: "standard",
    mapError: mapStoreError,
  }, (params: unknown) => Effect.gen(function* () {
      const [name, key] = params as [string, string]
      checkNamespace(name)
      checkKey(key)
      checkReserved(name)
      const store = checkStoreAvailable(name)
      try {
        const value = store.get(key)
        if (value === undefined || value === null) return null
        return typeof value === "string" ? value : JSON.stringify(value)
      } catch {
        throw new StorePersistenceError()
      }
    }),
  )

  // ── STORE_SET ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.STORE_SET,
    params: StoreSetParams,
    success: StoreSetSuccess,
    timeout: 5_000,
    senderPolicy: "standard",
    mapError: mapStoreError,
  }, (params: unknown) => Effect.gen(function* () {
      const [name, key, value] = params as [string, string, unknown]
      checkNamespace(name)
      checkKey(key)
      checkReserved(name)
      const store = checkStoreAvailable(name)
      try {
        store.set(key, value)
      } catch {
        throw new StorePersistenceError()
      }
    }),
  )

  // ── STORE_DELETE ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.STORE_DELETE,
    params: StoreDeleteParams,
    success: StoreDeleteSuccess,
    timeout: 5_000,
    senderPolicy: "standard",
    mapError: mapStoreError,
  }, (params: unknown) => Effect.gen(function* () {
      const [name, key] = params as [string, string]
      checkNamespace(name)
      checkKey(key)
      checkReserved(name)
      const store = checkStoreAvailable(name)
      try {
        store.delete(key)
      } catch {
        throw new StorePersistenceError()
      }
    }),
  )

  // ── STORE_CLEAR ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.STORE_CLEAR,
    params: StoreClearParams,
    success: StoreClearSuccess,
    timeout: 5_000,
    senderPolicy: "strict",
    mapError: mapStoreError,
  }, (params: unknown) => Effect.gen(function* () {
      const [name] = params as [string]
      checkNamespace(name)
      checkReserved(name)
      const store = checkStoreAvailable(name)
      try {
        store.clear()
      } catch {
        throw new StorePersistenceError()
      }
    }),
  )

  // ── STORE_KEYS ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.STORE_KEYS,
    params: StoreKeysParams,
    success: StoreKeysSuccess,
    timeout: 5_000,
    senderPolicy: "standard",
    mapError: mapStoreError,
  }, (params: unknown) => Effect.gen(function* () {
      const [name] = params as [string]
      checkNamespace(name)
      checkReserved(name)
      const store = checkStoreAvailable(name)
      return Object.keys(store.store)
    }),
  )

  // ── STORE_LENGTH ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.STORE_LENGTH,
    params: StoreLengthParams,
    success: StoreLengthSuccess,
    timeout: 5_000,
    senderPolicy: "standard",
    mapError: mapStoreError,
  }, (params: unknown) => Effect.gen(function* () {
      const [name] = params as [string]
      checkNamespace(name)
      checkReserved(name)
      const store = checkStoreAvailable(name)
      return Object.keys(store.store).length
    }),
  )
}
