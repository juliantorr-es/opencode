/**
 * Tests for simple props-based dialogs:
 * - DialogReleaseNotes (onboarding/pagination)
 * - DialogOnboarding (step navigation)
 * - DialogUsageExceeded (upsell/action)
 */
import { beforeAll, describe, expect, mock, test } from "bun:test"
import h from "solid-js/h/dist/h.js"
import { mountDialog } from "@/test-utils/dialog-harness"
import { mockAllDialogDeps, mockLanguage, mockSettings, mockPlatform } from "@/test-utils/dialog-mocks"

type ReleaseNotesMod = typeof import("./dialog-release-notes")
type OnboardingMod = typeof import("./dialog-onboarding")
type UsageExceededMod = typeof import("./dialog-usage-exceeded")
let releaseNotesMod: ReleaseNotesMod
let onboardingMod: OnboardingMod
let usageExceededMod: UsageExceededMod

beforeAll(async () => {
  mockAllDialogDeps()
  mockLanguage()
  mockSettings()
  mockPlatform()
  releaseNotesMod = await import("./dialog-release-notes")
  onboardingMod = await import("./dialog-onboarding")
  usageExceededMod = await import("./dialog-usage-exceeded")
})

// ── DialogReleaseNotes ─────────────────────────────────────────────────
describe("DialogReleaseNotes", () => {
  test("renders with highlights and pagination", async () => {
    const highlights = [
      { title: "Feature 1", description: "First feature" },
      { title: "Feature 2", description: "Second feature" },
    ]
    const dlg = await mountDialog(() =>
      h(releaseNotesMod.DialogReleaseNotes, { highlights }),
    )
    dlg.assertVisible()
    expect(document.body.textContent).toContain("Feature 1")
    expect(document.body.textContent).toContain("dialog.releaseNotes.action.next")
    dlg.dispose()
  })

  test("navigates through highlights with Next button", async () => {
    const highlights = [
      { title: "Feature A", description: "Desc A" },
      { title: "Feature B", description: "Desc B" },
      { title: "Feature C", description: "Desc C" },
    ]
    const dlg = await mountDialog(() =>
      h(releaseNotesMod.DialogReleaseNotes, { highlights }),
    )
    // First highlight visible - no text counter, click Next advances
    dlg.clickButton("dialog.releaseNotes.action.next")
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(releaseNotesMod.DialogReleaseNotes, { highlights: [{ title: "T", description: "D" }] }),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogOnboarding ───────────────────────────────────────────────────
describe("DialogOnboarding", () => {
  test("renders onboarding dialog", async () => {
    const dlg = await mountDialog(() =>
      h(onboardingMod.DialogOnboarding, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("renders at a specific step", async () => {
    const dlg = await mountDialog(() =>
      h(onboardingMod.DialogOnboarding, { startAt: 2 }),
    )
    dlg.assertVisible()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(onboardingMod.DialogOnboarding, {}),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})

// ── DialogUsageExceeded ────────────────────────────────────────────────
describe("DialogUsageExceeded", () => {
  test("renders upsell dialog with action button", async () => {
    const onClose = mock()
    const dlg = await mountDialog(() =>
      h(usageExceededMod.DialogUsageExceeded, {
        title: "Usage Limit",
        description: h("p", null, "You've hit your limit"),
        actionLabel: "Upgrade",
        onClose,
      }),
    )
    dlg.assertVisible()
    expect(document.body.textContent).toContain("Usage Limit")
    dlg.dispose()
  })

  test("clicking action button fires callback", async () => {
    const onClose = mock()
    const dlg = await mountDialog(() =>
      h(usageExceededMod.DialogUsageExceeded, {
        title: "Limit Reached",
        description: h("p", null, "Upgrade to continue"),
        actionLabel: "Go Pro",
        onClose,
      }),
    )
    dlg.clickButton("Go Pro")
    expect(onClose).toHaveBeenCalled()
    dlg.dispose()
  })

  test("disposes cleanly", async () => {
    const dlg = await mountDialog(() =>
      h(usageExceededMod.DialogUsageExceeded, {
        title: "Test",
        description: h("p", null, "Test"),
        actionLabel: "OK",
      }),
    )
    dlg.assertVisible()
    dlg.dispose()
    dlg.assertHidden()
  })
})
