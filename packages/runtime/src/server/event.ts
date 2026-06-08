import { BusEvent } from "@/bus/bus-event"
import { EventName } from "@/event/event-names"
import { Schema } from "effect"

export const Event = {
  Connected: BusEvent.define(EventName.ServerConnected, Schema.Struct({})),
  Disposed: BusEvent.define(EventName.GlobalDisposed, Schema.Struct({})),
  InstanceCreated: BusEvent.define(EventName.InstanceCreated, Schema.Struct({
    directory: Schema.String,
  })),
  InstanceLoaded: BusEvent.define(EventName.InstanceLoaded, Schema.Struct({
    directory: Schema.String,
  })),
  InstanceDegraded: BusEvent.define(EventName.InstanceDegraded, Schema.Struct({
    directory: Schema.String,
    failedServices: Schema.Array(Schema.String),
  })),
  InstanceFailed: BusEvent.define(EventName.InstanceFailed, Schema.Struct({
    directory: Schema.String,
    error: Schema.String,
  })),
}
