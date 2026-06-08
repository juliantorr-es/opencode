/**
 * Dialog Test Harness — SolidJS dialog component testing via hyperscript.
 *
 * Mounts dialog components directly (no DialogProvider/show() infrastructure).
 * Test files should mock @tribunus/ui context dependencies via mock.module().
 *
 * Usage:
 * ```ts
 * import { mountDialog } from "@/test-utils/dialog-harness"
 * import h from "solid-js/h"
 *
 * const dlg = await mountDialog(() => h(MyDialog, { title: "Hi" }))
 * dlg.assertVisible()
 * dlg.clickButton("Submit")
 * dlg.assertCallbackFired(onClose)
 * dlg.dispose()
 * ```
 */

import { render } from "solid-js/web/dist/web.js"
import { expect } from "bun:test"

export interface DialogHandle {
  /** Unmount the dialog and clean up the DOM. */
  dispose: () => void
  /** Find a button by visible text and click it. Throws if no match. */
  clickButton: (text: string) => void
  /** Assert a [data-component="dialog"] element is present. */
  assertVisible: () => void
  /** Assert no [data-component="dialog"] element is present. */
  assertHidden: () => void
  /** Assert a bun:test mock was invoked at least once. */
  assertCallbackFired: (fn: (...args: Array<unknown>) => unknown) => void
}

/**
 * Mount a dialog-like component in a test container.
 *
 * The component should render a wrapper with `data-component="dialog"` for
 * visibility assertions to work (the mock Dialog in dialog-mocks does this).
 */
export async function mountDialog(
  component: () => unknown,
): Promise<DialogHandle> {
  // Clean any previous test state
  const existing = document.getElementById("test-dialog-harness")
  if (existing) existing.remove()

  const container = document.createElement("div")
  container.id = "test-dialog-harness"
  container.style.display = "none"
  document.body.appendChild(container)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispose = (render as any)(() => component(), container) as () => void

  // Let SolidJS flush DOM updates
  await sleep(20)

  return {
    dispose: () => {
      dispose()
      container.remove()
    },

    clickButton(text: string) {
      const buttons = document.querySelectorAll<HTMLElement>(
        'button, [role="button"], input[type="button"], input[type="submit"], [data-component="button"]',
      )
      for (const btn of buttons) {
        const label = btn.textContent?.trim() ?? (btn as HTMLInputElement).value ?? ""
        if (label === text) {
          btn.click()
          return
        }
      }
      // Retry with substring match (handles i18n keys with dots)
      for (const btn of buttons) {
        const label = btn.textContent?.trim() ?? ""
        if (label.includes(text)) {
          btn.click()
          return
        }
      }
      throw new Error(
        `Button with text "${text}" not found.\n` +
        `Available buttons: ${[...buttons].map((b) => `"${b.textContent?.trim()}"`).join(", ")}`,
      )
    },

    assertVisible() {
      const el = document.querySelector('[data-component="dialog"]')
      expect(el, "Expected dialog to be visible in the DOM").toBeTruthy()
    },

    assertHidden() {
      const el = document.querySelector('[data-component="dialog"]')
      expect(el, "Expected dialog to NOT be in the DOM").toBeFalsy()
    },

    assertCallbackFired(fn: (...args: Array<unknown>) => unknown) {
      expect(fn).toHaveBeenCalled()
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
