import * as S from "../schema-compat"
import type { IpcMethodContract } from "../registry"

// ── Parameter schemas ──

const SecretRef = S.Struct({
  namespace: S.Str,
  accountID: S.Optional(S.Str),
  key: S.Str,
})

const SecretsSetParams = S.Tuple([SecretRef, S.Str])
const SecretsGetParams = S.Tuple([SecretRef])
const SecretsDeleteParams = S.Tuple([SecretRef])
const SecretsListParams = S.Tuple([S.Optional(S.Str)])

// ── Success schemas ──

const SecretsSetSuccess = S.UndefinedConst
const SecretsGetSuccess = S.Nullable(S.Str)
const SecretsDeleteSuccess = S.UndefinedConst
const SecretsListSuccess = S.Arr(
  S.Struct({
    namespace: S.Str,
    accountID: S.Optional(S.Str),
    key: S.Str,
    createdAt: S.Num,
    updatedAt: S.Num,
  }),
)
const SecretsStatusSuccess = S.Struct({
  available: S.Bool,
  encrypted: S.Bool,
  secretCount: S.Num,
})

// ── Contracts ──

export const contracts: readonly IpcMethodContract[] = [
  {
    channel: "tribunus:secrets-set",
    method: "secrets.set",
    params: SecretsSetParams,
    success: SecretsSetSuccess,
    category: "secrets",
    timeout: "short",
    sensitivity: "secret",
    senderPolicy: "strict",
    errors: ["invalid_request", "permission_denied", "not_found", "unavailable", "internal"],
    description: "Set a secret in the secure store for the given namespace/account/key",
  },
  {
    channel: "tribunus:secrets-get",
    method: "secrets.get",
    params: SecretsGetParams,
    success: SecretsGetSuccess,
    category: "secrets",
    timeout: "short",
    sensitivity: "secret",
    senderPolicy: "strict",
    errors: ["invalid_request", "permission_denied", "not_found", "unavailable", "internal"],
    description: "Retrieve a secret by namespace/account/key; returns null if absent",
  },
  {
    channel: "tribunus:secrets-delete",
    method: "secrets.delete",
    params: SecretsDeleteParams,
    success: SecretsDeleteSuccess,
    category: "secrets",
    timeout: "short",
    sensitivity: "secret",
    senderPolicy: "strict",
    errors: ["invalid_request", "permission_denied", "not_found", "unavailable", "internal"],
    description: "Delete a secret from the secure store",
  },
  {
    channel: "tribunus:secrets-list",
    method: "secrets.list",
    params: SecretsListParams,
    success: SecretsListSuccess,
    category: "secrets",
    timeout: "short",
    sensitivity: "secret",
    senderPolicy: "strict",
    errors: ["invalid_request", "permission_denied", "unavailable", "internal"],
    description: "List secrets, optionally filtered by namespace",
  },
  {
    channel: "tribunus:secrets-status",
    method: "secrets.status",
    params: S.Tuple([]),
    success: SecretsStatusSuccess,
    category: "secrets",
    timeout: "short",
    sensitivity: "secret",
    senderPolicy: "strict",
    errors: ["invalid_request", "unavailable", "internal"],
    description: "Check whether the secure store is available, encrypted, and how many secrets it holds",
  },
]
