import { ipcMain, safeStorage, app } from "electron"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"

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

export function registerSecretIpcHandlers() {
  ipcMain.handle(IPC.handle.SECRETS_SET, async (_event, ref: SecretRef, value: string) =>
    withIpcResult("secrets.set", () => setSecret(ref, value))
  )
  ipcMain.handle(IPC.handle.SECRETS_GET, async (_event, ref: SecretRef) =>
    withIpcResult("secrets.get", () => getSecret(ref))
  )
  ipcMain.handle(IPC.handle.SECRETS_DELETE, async (_event, ref: SecretRef) =>
    withIpcResult("secrets.delete", () => deleteSecret(ref))
  )
  ipcMain.handle(IPC.handle.SECRETS_LIST, async (_event, namespace?: string) =>
    withIpcResult("secrets.list", () => listSecretMetadata(namespace))
  )
  ipcMain.handle(IPC.handle.SECRETS_STATUS, async () =>
    withIpcResult("secrets.status", async () => {
      const index = loadIndex(app.getPath("userData"))
      const available = safeStorage.isEncryptionAvailable()
      return { available, encrypted: available, secretCount: Object.keys(index).length }
    })
  )
}
