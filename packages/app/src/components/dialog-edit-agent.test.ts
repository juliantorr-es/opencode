/**
 * Tests for DialogEditAgent — agent edit/create form.
 * Uses mountDialog() harness from DT-001.
 *
 * Covers: dialog-edit-agent (DT-002 mission spec)
 */
import { beforeAll, describe, expect, mock, test } from "bun:test"
import h from "solid-js/h/dist/h.js"
import { mountDialog } from "@/test-utils/dialog-harness"
import { mockAllDialogDeps, mockLanguage, mockProviders } from "@/test-utils/dialog-mocks"

type AgentDef = {
  id?: string
  name: string
  prompt: string
  description?: string
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  color?: string
}
type Mod = typeof import("./dialog-edit-agent")
let mod: Mod

beforeAll(async () => {
  mockAllDialogDeps()
  mockLanguage()
  mockProviders()
  mod = await import("./dialog-edit-agent")
})

describe("DialogEditAgent", () => {
  test("renders in create mode with form fields", async () => {
    const onSave = mock(async (_a: AgentDef) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditAgent, { onSave }),
    )
    dlg.assertVisible()
    // Uses language keys for titles
    expect(document.body.textContent).toContain("dialog.agents.name")
    expect(document.body.textContent).toContain("dialog.agents.prompt")
    // Create mode shows "dialog.agents.create" as dialog title
    expect(document.body.textContent).toContain("dialog.agents.create")
    dlg.dispose()
  })

  test("renders in edit mode with existing agent data", async () => {
    const agent: AgentDef = {
      name: "My Agent",
      prompt: "You are a helpful assistant",
      description: "Test agent description",
      temperature: 0.5,
      top_p: 0.9,
      color: "#6366f1",
    }
    const onSave = mock(async (_a: AgentDef) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditAgent, { agent, onSave }),
    )
    dlg.assertVisible()
    // Data from agent prop appears in form
    expect(document.body.textContent).toContain("My Agent")
    expect(document.body.textContent).toContain("You are a helpful assistant")
    expect(document.body.textContent).toContain("Test agent description")
    // Edit mode shows "dialog.agents.edit" title
    expect(document.body.textContent).toContain("dialog.agents.edit")
    dlg.dispose()
  })

  test("clicking Cancel leaves dialog visible (close is no-op in mock)", async () => {
    const onSave = mock(async (_a: AgentDef) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditAgent, { onSave }),
    )
    dlg.clickButton("common.cancel")
    dlg.assertVisible()
    dlg.dispose()
  })

  test("clicking Save calls onSave with agent data in edit mode", async () => {
    const agent: AgentDef = { name: "Test Agent", prompt: "You are a test helper" }
    const onSave = mock(async (_a: AgentDef) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditAgent, { agent, onSave }),
    )
    // Save button should be enabled since name is populated
    dlg.clickButton("common.save")
    expect(onSave).toHaveBeenCalled()
    dlg.dispose()
  })

  test("Save button is disabled when name is empty", async () => {
    const onSave = mock(async (_a: AgentDef) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditAgent, { onSave }),
    )
    // Find the Save button (last button in the form)
    const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-component="button"]')
    const saveBtn = buttons[buttons.length - 1] // Save is the last button
    expect(saveBtn?.disabled).toBe(true)
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const onSave = mock(async (_a: AgentDef) => {})
    const dlg = await mountDialog(() =>
      h(mod.DialogEditAgent, { onSave }),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})
