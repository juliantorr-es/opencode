/**
 * Tests for MCP-related dialogs:
 * - DialogSelectMcp (MCP server list)
 *
 * Note: DialogEditMcp tested separately in dialog-edit-mcp.test.ts
 */
import { beforeAll, describe, expect, mock, test } from "bun:test"
import h from "solid-js/h/dist/h.js"
import { mountDialog } from "@/test-utils/dialog-harness"
import { mockAllDialogDeps, mockLanguage, mockSync, mockSDK, mockServerContext } from "@/test-utils/dialog-mocks"

type SelectMcpMod = typeof import("./dialog-select-mcp")
let selectMcpMod: SelectMcpMod

beforeAll(async () => {
  mockAllDialogDeps()
  mockLanguage()
  mockSync()
  mockSDK()
  mockServerContext()
  selectMcpMod = await import("./dialog-select-mcp")
})

// ── DialogSelectMcp ────────────────────────────────────────────────────
describe("DialogSelectMcp", () => {
  test("renders MCP server selection dialog", async () => {
    const dlg = await mountDialog(() =>
      h(selectMcpMod.DialogSelectMcp, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(selectMcpMod.DialogSelectMcp, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})
