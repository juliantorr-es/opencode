// Bridge: sidecar needs a token at runtime → asks Electron main via IPC.
// This is a thin wrapper so the sidecar never touches safeStorage or the secret index.

import { ipcMain } from "electron"
import { getSecret } from "./desktop-secret-store"
import { withIpcResult } from "./ipc-contract"

export function registerSidecarSecretBridge() {
  // The sidecar can request a specific secret by ref via a dedicated IPC channel.
  // For now, this is handled via the existing SECRETS_GET channel in desktop-secret-store.ts.
  // This module exists as a hook point for future sidecar-specific auth policies
  // (e.g., rate-limiting, audit logging, per-session tokens).
}
