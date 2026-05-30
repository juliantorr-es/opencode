import { BusEvent } from "@/bus/bus-event"
import { EventName } from "@/event/event-names"
import { Schema } from "effect"

export const Event = {
  Connected: BusEvent.define(EventName.ServerConnected, Schema.Struct({})),
  Disposed: BusEvent.define(EventName.GlobalDisposed, Schema.Struct({})),
}
