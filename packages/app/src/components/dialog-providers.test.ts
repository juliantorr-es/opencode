/**
 * Tests for provider and model selection dialogs:
 * - DialogSelectProvider (provider list)
 * - DialogSelectModel (model picker)
 * - DialogSelectModelUnpaid (unpaid model warning)
 * - DialogCommandPalette (command palette)
 */
import { beforeAll, describe, expect, mock, test } from "bun:test"
import h from "solid-js/h/dist/h.js"
import { mountDialog } from "@/test-utils/dialog-harness"
import { mockAllDialogDeps, mockLanguage, mockLocal, mockProviders, mockCommand } from "@/test-utils/dialog-mocks"

type SelectProviderMod = typeof import("./dialog-select-provider")
type SelectModelMod = typeof import("./dialog-select-model")
type SelectModelUnpaidMod = typeof import("./dialog-select-model-unpaid")
type CommandPaletteMod = typeof import("./dialog-command-palette")
let selectProviderMod: SelectProviderMod
let selectModelMod: SelectModelMod
let selectModelUnpaidMod: SelectModelUnpaidMod
let commandPaletteMod: CommandPaletteMod

beforeAll(async () => {
  mockAllDialogDeps()
  mockLanguage()
  mockLocal()
  mockProviders()
  mockCommand()
  selectProviderMod = await import("./dialog-select-provider")
  selectModelMod = await import("./dialog-select-model")
  selectModelUnpaidMod = await import("./dialog-select-model-unpaid")
  commandPaletteMod = await import("./dialog-command-palette")
})

// ── DialogSelectProvider ───────────────────────────────────────────────
describe("DialogSelectProvider", () => {
  test("renders provider selection dialog", async () => {
    const dlg = await mountDialog(() =>
      h(selectProviderMod.DialogSelectProvider, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(selectProviderMod.DialogSelectProvider, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogSelectModel ──────────────────────────────────────────────────
describe("DialogSelectModel", () => {
  test("renders model selection dialog", async () => {
    const dlg = await mountDialog(() =>
      h(selectModelMod.DialogSelectModel, { provider: "anthropic" }),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(selectModelMod.DialogSelectModel, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogSelectModelUnpaid ────────────────────────────────────────────
describe("DialogSelectModelUnpaid", () => {
  test("renders unpaid model warning dialog", async () => {
    const dlg = await mountDialog(() =>
      h(selectModelUnpaidMod.DialogSelectModelUnpaid, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(selectModelUnpaidMod.DialogSelectModelUnpaid, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogCommandPalette ───────────────────────────────────────────────
describe("DialogCommandPalette", () => {
  test("renders command palette dialog", async () => {
    const dlg = await mountDialog(() =>
      h(commandPaletteMod.DialogCommandPalette, {}),
    )
    // DialogCommandPalette uses a plain <div> wrapper, not <Dialog>
    expect(document.querySelector('[data-component="command-palette"]')).toBeTruthy()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(commandPaletteMod.DialogCommandPalette, {}),
    )
    expect(document.querySelector('[data-component="command-palette"]')).toBeTruthy()
    dlg.dispose()
    expect(document.querySelector('[data-component="command-palette"]')).toBeFalsy()
  })
})
