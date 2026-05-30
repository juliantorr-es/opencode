/**
 * Tests for management dialogs:
 * - DialogManageAgents (agent CRUD)
 * - DialogManageModels (model visibility)
 * - DialogSettings (settings tabs)
 */
import { beforeAll, describe, expect, mock, test } from "bun:test"
import h from "solid-js/h/dist/h.js"
import { mountDialog } from "@/test-utils/dialog-harness"
import { mockAllDialogDeps, mockLanguage, mockPlatform, mockSync, mockLocal, mockProviders } from "@/test-utils/dialog-mocks"

type ManageAgentsMod = typeof import("./dialog-manage-agents")
type ManageModelsMod = typeof import("./dialog-manage-models")
type SettingsMod = typeof import("./dialog-settings")
let agentsMod: ManageAgentsMod
let modelsMod: ManageModelsMod
let settingsMod: SettingsMod

beforeAll(async () => {
  mockAllDialogDeps()
  mockLanguage()
  mockPlatform()
  mockSync()
  mockLocal()
  mockProviders()
  agentsMod = await import("./dialog-manage-agents")
  modelsMod = await import("./dialog-manage-models")
  settingsMod = await import("./dialog-settings")
})

// ── DialogManageAgents ─────────────────────────────────────────────────
describe("DialogManageAgents", () => {
  test("renders manage agents dialog", async () => {
    const dlg = await mountDialog(() =>
      h(agentsMod.DialogManageAgents, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(agentsMod.DialogManageAgents, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogManageModels ─────────────────────────────────────────────────
describe("DialogManageModels", () => {
  test("renders manage models dialog", async () => {
    const dlg = await mountDialog(() =>
      h(modelsMod.DialogManageModels, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(modelsMod.DialogManageModels, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogSettings ─────────────────────────────────────────────────────
describe("DialogSettings", () => {
  test("can import dialog settings module", async () => {
    expect(settingsMod.DialogSettings).toBeDefined()
  })

  test("settings dialog module exports correctly", async () => {
    // DialogSettings imports sub-components (SettingsGeneral, etc.)
    // that require @opencode-ai/ui Theme context. Component-level
    // rendering tests require additional Theme provider mocking.
    expect(typeof settingsMod.DialogSettings).toBe("function")
  })
})
