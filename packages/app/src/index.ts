export { AppBaseProviders, AppInterface } from "./app"
export { ACCEPTED_FILE_EXTENSIONS, ACCEPTED_FILE_TYPES, filePickerFilters } from "./constants/file-picker"
export { useCommand } from "./context/command"
export { loadLocaleDict, normalizeLocale, type Locale } from "./context/language"
export { type DisplayBackend, type FatalRendererErrorLog, type Platform, PlatformProvider } from "./context/platform"
export { ServerConnection } from "./context/server"
export { handleNotificationClick } from "./utils/notification-click"
export { decodeOrThrow, SidecarConfig } from "./context/server-sync"

// ── PWA Mobile Cockpit ───────────────────────────────────────────

export { projectionStream, commandGateway, notificationGateway, pairingManager } from "./pwa"
export type {
  ProjectionKind,
  ProjectionDelta,
  ProjectionCache,
  ConnectionStatus,
  CockpitCommand,
  GrantedCapability,
  CommandIntent,
  CommandResponse,
  PushAlertKind,
  PushAlertPayload,
  PushPermission,
  PairingPayload,
  PairedSession,
} from "./pwa"
