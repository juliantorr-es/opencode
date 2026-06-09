import * as S from "../schema-compat"
import type { IpcMethodContract } from "../registry"

// ── Parameter schemas ──
const StoreGetParams = S.Tuple([S.Str, S.Str])
const StoreSetParams = S.Tuple([S.Str, S.Str, S.Unknown])
const StoreDeleteParams = S.Tuple([S.Str, S.Str])
const StoreClearParams = S.Tuple([S.Str])
const StoreKeysParams = S.Tuple([S.Str])
const StoreLengthParams = S.Tuple([S.Str])

// ── Success schemas ──
const StoreGetSuccess = S.Nullable(S.Str)
const StoreSetSuccess = S.UndefinedConst
const StoreDeleteSuccess = S.UndefinedConst
const StoreClearSuccess = S.UndefinedConst
const StoreKeysSuccess = S.Arr(S.Str)
const StoreLengthSuccess = S.Num

// ── Common contract fields ──
const category = "store" as const
const timeout = "short" as const
const sensitivity = "internal" as const
const errors = ["invalid_request", "permission_denied", "internal"] as const

// ── Contracts ──
export const contracts: readonly IpcMethodContract[] = [
  {
    channel: "tribunus:store-get",
    method: "store.get",
    params: StoreGetParams,
    success: StoreGetSuccess,
    category,
    timeout,
    sensitivity,
    senderPolicy: "standard",
    errors,
    description: "Get a value from the named store by key; returns null when the key does not exist",
  },
  {
    channel: "tribunus:store-set",
    method: "store.set",
    params: StoreSetParams,
    success: StoreSetSuccess,
    category,
    timeout,
    sensitivity,
    senderPolicy: "standard",
    errors,
    description: "Set a value in the named store under the given key",
  },
  {
    channel: "tribunus:store-delete",
    method: "store.delete",
    params: StoreDeleteParams,
    success: StoreDeleteSuccess,
    category,
    timeout,
    sensitivity,
    senderPolicy: "standard",
    errors,
    description: "Delete a key from the named store",
  },
  {
    channel: "tribunus:store-clear",
    method: "store.clear",
    params: StoreClearParams,
    success: StoreClearSuccess,
    category,
    timeout,
    sensitivity,
    senderPolicy: "strict",
    errors,
    description: "Clear all entries from the named store (requires strict sender policy)",
  },
  {
    channel: "tribunus:store-keys",
    method: "store.keys",
    params: StoreKeysParams,
    success: StoreKeysSuccess,
    category,
    timeout,
    sensitivity,
    senderPolicy: "standard",
    errors,
    description: "List all keys in the named store",
  },
  {
    channel: "tribunus:store-length",
    method: "store.length",
    params: StoreLengthParams,
    success: StoreLengthSuccess,
    category,
    timeout,
    sensitivity,
    senderPolicy: "standard",
    errors,
    description: "Return the number of entries in the named store",
  },
]
