import { safeStorage, app } from "electron"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { IPC } from "./ipc-channels"
import { Effect } from "effect"
import { registerIpcEffectHandler } from "./ipc-adapter"
import type { DesktopRuntime } from "./effect/desktop-runtime"
import * as S from "../ipc/schema-compat"
import { mapSecretError } from "./errors/secrets-errors"

export interface SecretRef {
  namespace: "provider" | "github" | "plugin" | "coordination" | "team"
  accountID?: string
  key: string
}

export interface SecretMetadata {
  namespace: string
  accountID?: string
  key: string
  createdAt: number
  updatedAt: number
}

interface SecretIndex {
  [id: string]: {
    createdAt: number
    updatedAt: number
    encrypted: string // base64 ciphertext
  }
}

let secretIndexPath: string
let indexCache: SecretIndex | undefined

function ensureSecretStoreDir(userDataPath: string): string {
  const dir = join(userDataPath, "data", "secrets")
  mkdirSync(dir, { recursive: true })
  return dir
}

function getSecretIndexPath(userDataPath: string): string {
  return join(ensureSecretStoreDir(userDataPath), "index.json")
}

function loadIndex(userDataPath: string): SecretIndex {
  if (secretIndexPath !== getSecretIndexPath(userDataPath)) {
    secretIndexPath = getSecretIndexPath(userDataPath)
    indexCache = undefined
  }
  if (indexCache) return indexCache
  if (existsSync(secretIndexPath)) {
    try {
      indexCache = JSON.parse(readFileSync(secretIndexPath, "utf-8"))
    } catch {
      indexCache = {}
    }
  } else {
    indexCache = {}
  }
  return indexCache!
}

function saveIndex(userDataPath: string, index: SecretIndex): void {
  writeFileSync(getSecretIndexPath(userDataPath), JSON.stringify(index, null, 2), "utf-8")
  indexCache = index
}

function refToId(ref: SecretRef): string {
  const accountPart = ref.accountID ? `${ref.accountID}:` : ""
  return `${ref.namespace}:${accountPart}${ref.key}`
}

function idToMetadata(id: string): { namespace: string; accountID?: string; key: string } {
  const parts = id.split(":")
  const namespace = parts[0]
  if (parts.length < 2) return { namespace, key: id }
  const maybeAccount = parts[1]
  if (maybeAccount && (namespace === "github" || namespace === "provider" || namespace === "team")) {
    return { namespace, accountID: maybeAccount, key: parts.slice(2).join(":") }
  }
  return { namespace, key: parts.slice(1).join(":") }
}

export async function setSecret(ref: SecretRef, value: string): Promise<void> {
  const userDataPath = app.getPath("userData")
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("safeStorage encryption not available")
  }
  const encrypted = safeStorage.encryptString(value)
  const index = loadIndex(userDataPath)
  const id = refToId(ref)
  const now = Date.now()
  const existing = index[id]
  index[id] = {
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    encrypted: encrypted.toString("base64"),
  }
  saveIndex(userDataPath, index)
}

export async function getSecret(ref: SecretRef): Promise<string | null> {
  const userDataPath = app.getPath("userData")
  if (!safeStorage.isEncryptionAvailable()) return null
  const index = loadIndex(userDataPath)
  const entry = index[refToId(ref)]
  if (!entry) return null
  return safeStorage.decryptString(Buffer.from(entry.encrypted, "base64"))
}

export async function deleteSecret(ref: SecretRef): Promise<void> {
  const userDataPath = app.getPath("userData")
  const index = loadIndex(userDataPath)
  delete index[refToId(ref)]
  saveIndex(userDataPath, index)
}

export async function listSecretMetadata(namespace?: string): Promise<SecretMetadata[]> {
  const userDataPath = app.getPath("userData")
  const index = loadIndex(userDataPath)
  const results: SecretMetadata[] = []
  for (const id of Object.keys(index)) {
    const meta = idToMetadata(id)
    if (namespace && meta.namespace !== namespace) continue
    const entry = index[id]
    results.push({ ...meta, createdAt: entry.createdAt, updatedAt: entry.updatedAt })
  }
  return results
}

export function registerSecretIpcHandlers(runtime: DesktopRuntime) {
  // ── SECRETS_SET ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SECRETS_SET,
    params: S.Tuple([S.Struct({
      namespace: S.Str,
      accountID: S.Optional(S.Str),
      key: S.Str,
    }), S.Str]),
    success: S.UndefinedConst,
    timeout: 10_000,
    senderPolicy: "strict",
    mapError: mapSecretError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [ref, value] = params as [any, string]
    if (!value || value.length === 0) throw new Error("Secret value must be non-empty")
    await setSecret(ref, value)
  }))

  // ── SECRETS_GET ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SECRETS_GET,
    params: S.Tuple([S.Struct({
      namespace: S.Str,
      accountID: S.Optional(S.Str),
      key: S.Str,
    })]),
    success: S.Nullable(S.Str),
    timeout: 10_000,
    senderPolicy: "strict",
    mapError: mapSecretError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [ref] = params as [any]
    return getSecret(ref)
  }))

  // ── SECRETS_DELETE ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SECRETS_DELETE,
    params: S.Tuple([S.Struct({
      namespace: S.Str,
      accountID: S.Optional(S.Str),
      key: S.Str,
    })]),
    success: S.UndefinedConst,
    timeout: 10_000,
    senderPolicy: "strict",
    mapError: mapSecretError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [ref] = params as [any]
    await deleteSecret(ref)
  }))

  // ── SECRETS_LIST ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SECRETS_LIST,
    params: S.Tuple([S.Optional(S.Str)]),
    success: S.Arr(S.Struct({
      namespace: S.Str,
      accountID: S.Optional(S.Str),
      key: S.Str,
      createdAt: S.Num,
      updatedAt: S.Num,
    })),
    timeout: 10_000,
    senderPolicy: "strict",
    mapError: mapSecretError,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [namespace] = params as [string | undefined]
    return listSecretMetadata(namespace)
  }))

  // ── SECRETS_STATUS ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SECRETS_STATUS,
    params: S.Tuple([]),
    success: S.Struct({
      available: S.Bool,
      encrypted: S.Bool,
      secretCount: S.Num,
    }),
    timeout: 10_000,
    senderPolicy: "strict",
    mapError: mapSecretError,
  }, () => Effect.tryPromise(async () => {
    const index = loadIndex(app.getPath("userData"))
    const available = safeStorage.isEncryptionAvailable()
    return { available, encrypted: available, secretCount: Object.keys(index).length }
  }))
}
