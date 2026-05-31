import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    // Invoke each listener individually so one throw doesn't kill remaining listeners
    const listeners = this.rawListeners(eventName) as Array<(event: GlobalEvent) => void>
    if (listeners.length === 0) return false
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error("[GlobalBus] subscriber error:", error)
      }
    }
    return true
  }
}

export const GlobalBus = new GlobalBusEmitter()
