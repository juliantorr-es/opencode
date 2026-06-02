import {
  notify,
  getNotificationStatus,
  type DesktopNotificationInput,
} from "./desktop-notification-service"

export interface RoutedEvent {
  source: "sidecar" | "project_activation" | "valkey" | "release_binder"
  kind: "error" | "blocked" | "ready" | "failed" | "complete"
  message: string
  details?: Record<string, unknown>
}

export function routeEvent(event: RoutedEvent): void {
  const input = eventToNotification(event)
  if (!input) return
  notify(input)
}

function eventToNotification(event: RoutedEvent): DesktopNotificationInput | null {
  switch (event.source) {
    case "sidecar":
      if (event.kind === "failed" || event.kind === "error") {
        return {
          kind: "sidecar_failed",
          title: "Sidecar Failed",
          body: event.message,
          actionRef: "open_diagnostics",
          project: event.details?.project as string | undefined,
        }
      }
      return null

    case "project_activation":
      if (event.kind === "failed") {
        return {
          kind: "project_activation_failed",
          title: "Project Activation Failed",
          body: event.message,
          actionRef: "open_diagnostics",
          project: event.details?.project as string | undefined,
        }
      }
      return null

    case "valkey":
      if (event.kind === "failed" || event.kind === "error") {
        return {
          kind: "sidecar_failed",
          title: "Coordination Error",
          body: event.message,
          actionRef: "open_diagnostics",
        }
      }
      return null

    case "release_binder":
      if (event.kind === "complete") {
        return {
          kind: "release_binder_complete",
          title: "Release Binder Ready",
          body: event.message,
          actionRef: "open_diagnostics",
        }
      }
      return null

    default:
      return null
  }
}

/** Report routing diagnostics */
export function getEventRouterStatus() {
  return {
    ...getNotificationStatus(),
    routing: "active",
  }
}
