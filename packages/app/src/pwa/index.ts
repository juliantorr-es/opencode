/**
 * PWA Mobile Cockpit — re-exports.
 *
 * Use `import { projectionStream, commandGateway, notificationGateway, pairingManager, offlineCache } from "@/pwa"`.
 */

export { projectionStream, createProjectionStream } from "./projection-stream"
export type {
  ProjectionKind,
  ProjectionDelta,
  ProjectionStreamState,
  ProjectionCache,
  ConnectionStatus,
  ProjectionStreamClient,
} from "./projection-stream"

export { commandGateway, createCommandGateway } from "./command-gateway"
export type {
  CockpitCommand,
  GrantedCapability,
  CommandIntent,
  CommandResponse,
  QueuedCommand,
  CommandGateway,
} from "./command-gateway"

export { notificationGateway, createNotificationGateway } from "./notification-gateway"
export type {
  PushAlertKind,
  PushAlertPayload,
  PushPermission,
  NotificationGatewayState,
  NotificationGateway,
} from "./notification-gateway"

export { pairingManager, createPairingManager } from "./pairing"
export type {
  PairingPayload,
  PairedSession,
  PairingManager,
} from "./pairing"

export { offlineCache, createOfflineCache } from "./offline-cache"
export type {
  OfflineNotification,
  BannerVisibility,
  OfflineCache,
} from "./offline-cache"
