/**
 * Tests for DialogEditMcp — MCP server form (add/edit).
 * Uses mountDialog() harness from DT-001.
 *
 * Note: DialogEditMcp is a FORM FRAGMENT (no <Dialog> wrapper).
 * It renders inside DialogSelectMcp. Tests verify content and interactions
 * directly without assertVisible/assertHidden.
 *
 * Covers: dialog-mcp-form (mission spec)
 */
import { beforeAll, describe, expect, mock, test } from "bun:test"
import h from "solid-js/h/dist/h.js"
import { mountDialog } from "@/test-utils/dialog-harness"
import { mockAllDialogDeps, mockLanguage } from "@/test-utils/dialog-mocks"

type Entry = { name: string; config: { type: "local" | "remote"; command?: string[]; url?: string; timeout?: number; enabled: boolean } }
type Mod = typeof import("./dialog-edit-mcp")
let mod: Mod

beforeAll(async () => {
  mockAllDialogDeps()
  mockLanguage()
  mod = await import("./dialog-edit-mcp")
})

describe("DialogEditMcp", () => {
  // ── smoke ─────────────────────────────────────────────────────────────
  test("renders with default props (add mode)", async () => {
    const onSave = mock(async (_e: Entry) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditMcp, { onSave }),
    )
    // DialogEditMcp is a form fragment — no [data-component="dialog"] wrapper
    expect(document.body.textContent).toContain("dialog.mcp.form.name")
    expect(document.body.textContent).toContain("dialog.mcp.form.command")
    expect(document.body.textContent).toContain("common.cancel")
    expect(document.body.textContent).toContain("common.save")
    dlg.dispose()
  })

  test("renders with existing entry (edit mode)", async () => {
    const entry: Entry = {
      name: "test-server",
      config: { type: "local", command: ["node", "server.js"], enabled: true },
    }
    const onSave = mock(async (_e: Entry) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditMcp, { entry, onSave }),
    )
    expect(document.body.textContent).toContain("test-server")
    dlg.dispose()
  })

  // ── interaction ───────────────────────────────────────────────────────
  test("clicking Cancel fires onCancel callback", async () => {
    const onCancel = mock()
    const onSave = mock(async (_e: Entry) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditMcp, { onSave, onCancel }),
    )
    dlg.clickButton("common.cancel")
    expect(onCancel).toHaveBeenCalledTimes(1)
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const onSave = mock(async (_e: Entry) => {})
    const dlg = await mountDialog(() => h(mod.DialogEditMcp, { onSave }))
    expect(document.body.textContent).toContain("dialog.mcp.form.name")
    dlg.dispose()
  })
})
