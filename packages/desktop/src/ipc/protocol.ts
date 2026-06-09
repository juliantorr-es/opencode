import { Schema } from "effect"
import { PublicIpcError } from "./errors"

/** Protocol version for wire evolution. Version 1 for this mission. */
export const ProtocolVersion = Schema.Literal(1)
export type ProtocolVersion = typeof ProtocolVersion.Type

/** Request identity — correlation ID for tracing and debugging. */
export const RequestId = Schema.String.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type

/** Successful result envelope. */
export const IpcOkSchema = Schema.Struct({
  ok: Schema.Literal(true),
  protocolVersion: ProtocolVersion,
  requestId: RequestId,
  value: Schema.Unknown,
})
export type IpcOk = typeof IpcOkSchema.Type

/** Failed result envelope with public error info. */
export const IpcErrSchema = Schema.Struct({
  ok: Schema.Literal(false),
  protocolVersion: ProtocolVersion,
  requestId: RequestId,
  error: PublicIpcError,
})
export type IpcErr = typeof IpcErrSchema.Type
