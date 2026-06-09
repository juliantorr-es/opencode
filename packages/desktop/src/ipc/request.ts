import { RequestId } from "./protocol"

/** Creates a new request identity — timestamped, unique, no crypto dependency. */
let _counter = 0
export function newRequestId(): RequestId {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  const count = (++_counter).toString(36)
  return `${timestamp}-${random}-${count}` as RequestId
}
