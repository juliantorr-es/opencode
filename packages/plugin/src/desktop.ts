import type { Component } from "solid-js"

// === Host Slot Definitions ===

/** Built-in slot names for the Electron desktop renderer */
export type DesktopHostSlotMap = {
  window_titlebar: {}
  window_titlebar_left: {}
  sidebar_content: {}
  sidebar_footer: {}
}

/** Slot positions — extends host slots with custom plugin slots */
export type DesktopSlotMap<Slots extends Record<string, object> = {}> = DesktopHostSlotMap & Slots

/** A component registered at a specific desktop slot */
export type DesktopSlotPlugin<Slots extends Record<string, object> = {}> = {
  slots: {
    [Name in keyof (DesktopHostSlotMap & Slots)]?: Component<(DesktopHostSlotMap & Slots)[Name]>
  }
}

/** Lifecycle and API for a desktop plugin */
export type DesktopPluginApi = {
  /** Register slot components at named positions. Returns unregister function. */
  slots: {
    register(slotPlugin: DesktopSlotPlugin): () => void
  }
  /** Key-value store scoped to this plugin */
  store: {
    get: (key: string) => unknown
    set: (key: string, value: unknown) => void
  }
  /** Lifecycle management */
  lifecycle: {
    onDispose: (fn: () => void) => void
  }
}

/** A desktop plugin is a function that receives the API and returns nothing (async) */
export type DesktopPlugin = (api: DesktopPluginApi) => Promise<void>

/** Module format for desktop plugins (mutually exclusive with server and tui) */
export type DesktopPluginModule = {
  id?: string
  desktop: DesktopPlugin
  server?: never
  tui?: never
}
