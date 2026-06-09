/**
 * Aggregate IPC contract registry — imports all domain contracts and registers them.
 * This is the single source of truth for which methods exist and their contracts.
 */
import { IpcContractRegistry } from "../registry"
import { contracts as initContracts } from "./init"
import { contracts as storeContracts } from "./store"
import { contracts as fsContracts } from "./fs"
import { contracts as githubContracts } from "./github"
import { contracts as secretsContracts } from "./secrets"

/** Aggregate all domain contract arrays. Add new domains here. */
const allContracts = [
  ...initContracts,
  ...storeContracts,
  ...fsContracts,
  ...githubContracts,
  ...secretsContracts,
]

/** The single registry instance for the application. */
export const ipcRegistry = new IpcContractRegistry()

// Register all contracts — throws on duplicates
ipcRegistry.registerInvoke(...allContracts)

/** Expected channel set for coverage validation */
export const expectedChannels = new Set(allContracts.map((c) => c.channel))

/** Return the number of registered invoke methods. */
export function invokeCount(): number {
  return ipcRegistry.invokes.size / 2 // each stored twice (by method + by channel)
}

/** Return the full list of registered logical method names. */
export function registeredMethods(): string[] {
  const methods = new Set<string>()
  for (const c of allContracts) {
    methods.add(c.method)
  }
  return [...methods].sort()
}
