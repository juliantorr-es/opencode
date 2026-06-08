import { describe, expect, test } from "bun:test"
import { toSMEvent, toStoreEvent, getRoleForState, STATE_ROLE } from "./secretary"

test("quick import check", () => {
  expect(typeof toSMEvent).toBe("function")
  expect(typeof toStoreEvent).toBe("function")
  expect(typeof getRoleForState).toBe("function")
  expect(typeof STATE_ROLE).toBe("object")
  expect(getRoleForState("scouting")).toBe("cartographer")
})
