/**
 * Tests for context-based export/import/fork dialogs:
 * - DialogExport (export session)
 * - DialogImport (import session)
 * - DialogFork (fork conversation)
 */
import { beforeAll, describe, expect, mock, test } from "bun:test"
import h from "solid-js/h/dist/h.js"
import { mountDialog } from "@/test-utils/dialog-harness"
import { mockAllDialogDeps, mockLanguage, mockPlatform, mockSync, mockSDK, mockPrompt, mockServerContext } from "@/test-utils/dialog-mocks"

type ExportMod = typeof import("./dialog-export")
type ImportMod = typeof import("./dialog-import")
type ForkMod = typeof import("./dialog-fork")
let exportMod: ExportMod
let importMod: ImportMod
let forkMod: ForkMod

beforeAll(async () => {
  mockAllDialogDeps()
  mockLanguage()
  mockPlatform()
  mockSync()
  mockSDK()
  mockPrompt()
  mockServerContext()
  exportMod = await import("./dialog-export")
  importMod = await import("./dialog-import")
  forkMod = await import("./dialog-fork")
})

// ── DialogExport ───────────────────────────────────────────────────────
describe("DialogExport", () => {
  test("renders export dialog", async () => {
    const dlg = await mountDialog(() =>
      h(exportMod.DialogExport, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(exportMod.DialogExport, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogImport ───────────────────────────────────────────────────────
describe("DialogImport", () => {
  test("renders import dialog", async () => {
    const dlg = await mountDialog(() =>
      h(importMod.DialogImport, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(importMod.DialogImport, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogFork ─────────────────────────────────────────────────────────
describe("DialogFork", () => {
  test("renders fork dialog", async () => {
    const dlg = await mountDialog(() =>
      h(forkMod.DialogFork, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(forkMod.DialogFork, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})
