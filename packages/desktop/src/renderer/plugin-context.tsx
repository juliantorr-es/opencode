import {
  ErrorBoundary,
  type Component,
  createContext,
  createSignal,
  onCleanup,
  onMount,
  useContext,
} from "solid-js"
import type { DesktopHostSlotMap } from "@opencode-ai/plugin/desktop"
import { DesktopPluginLoader } from "./plugin-loader"

type SlotName = keyof DesktopHostSlotMap
type SlotRegistry = Map<SlotName, Component<{}>>

interface DesktopPluginContextValue {
  slots: SlotRegistry
  registerSlot: (name: SlotName, component: Component<{}>) => () => void
}

const DesktopPluginContext = createContext<DesktopPluginContextValue>()

export function DesktopPluginProvider(props: { children: any }) {
  const [slots, setSlots] = createSignal<SlotRegistry>(new Map())

  const registerSlot = (name: SlotName, component: Component<{}>) => {
    setSlots((prev) => {
      const next = new Map(prev)
      next.set(name, component)
      return next
    })
    return () => {
      setSlots((prev) => {
        const next = new Map(prev)
        next.delete(name)
        return next
      })
    }
  }

  // Load desktop plugins from IPC config on mount
  onMount(() => {
    const loader = new DesktopPluginLoader(registerSlot)
    loader.loadAll().catch(console.error)
    onCleanup(() => loader.dispose())
  })

  return (
    <DesktopPluginContext.Provider value={{ slots: slots(), registerSlot }}>
      {props.children}
    </DesktopPluginContext.Provider>
  )
}

/** Render the registered component for a named slot, or null if no plugin registered */
export function DesktopSlotRenderer(props: { name: SlotName }) {
  const ctx = useContext(DesktopPluginContext)
  if (!ctx) return null

  const component = ctx.slots.get(props.name)
  if (!component) return null

  return (
    <ErrorBoundary fallback={<div style={{ display: "none" }} />}>
      {component({})}
    </ErrorBoundary>
  )
}

/** Hook to register a slot plugin component on mount and unregister on cleanup */
export function useDesktopSlot(name: SlotName, component: Component<{}>) {
  const ctx = useContext(DesktopPluginContext)
  if (!ctx) return

  onMount(() => {
    const unregister = ctx.registerSlot(name, component)
    onCleanup(() => unregister())
  })
}
