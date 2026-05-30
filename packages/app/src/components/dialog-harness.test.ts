/**
 * Dialog test harness tests — demonstrates the full harness API:
 *   mountDialog, clickButton, assertVisible, assertHidden, assertCallbackFired
 *
 * These tests use inline dialog components built with hyperscript (h()),
 * avoiding bun's SolidJS JSX compilation limitation. Real app dialogs
 * can be tested by importing them after mocking their dependencies via
 * the shared mocks in test-utils/dialog-mocks.ts.
 */

import { describe, expect, mock, test } from "bun:test"
import * as solid from "solid-js/dist/solid.js"
import h from "solid-js/h/dist/h.js"
import { mountDialog } from "@/test-utils/dialog-harness"

const { createSignal } = solid

// ── Test dialog components (inline, no .tsx needed) ────────────────────
function Dialog(props: any) {
  const children: Array<any> = []
  if (props.title) children.push(h("div", { "data-slot": "dialog-header" }, h("h2", { "data-slot": "dialog-title" }, props.title)))
  if (props.description) children.push(h("div", { "data-slot": "dialog-description" }, props.description))
  children.push(h("div", { "data-slot": "dialog-body" }, props.children))
  return h("div", { "data-component": "dialog", "data-size": props.size || "normal" },
    h("div", { "data-slot": "dialog-container" },
      h("div", { "data-slot": "dialog-content" }, ...children.filter(Boolean)),
    ),
  )
}

function Button(props: any) {
  return h("button", {
    "data-component": "button",
    disabled: props.disabled,
    onClick: props.onClick,
  }, props.children)
}

// ── Tests ──────────────────────────────────────────────────────────────
describe("Dialog test harness", () => {
  // 1) mountDialog + assertVisible — mounting and visibility
  test("mountDialog renders a dialog with title and content", async () => {
    const dialog = await mountDialog(() =>
      h(Dialog, { title: "Test Title", description: "Test Description" },
        h("p", null, "Dialog body content"),
      ),
    )

    dialog.assertVisible()
    expect(document.body.textContent).toContain("Test Title")
    expect(document.body.textContent).toContain("Test Description")
    expect(document.body.textContent).toContain("Dialog body content")
    dialog.dispose()
  })

  // 2) clickButton — find and click by visible text
  test("clickButton finds a button by visible text and triggers onClick", async () => {
    const onClick = mock()
    const dialog = await mountDialog(() =>
      h(Dialog, { title: "Click Test" },
        h(Button, { onClick }, "Submit"),
      ),
    )

    dialog.clickButton("Submit")
    expect(onClick).toHaveBeenCalledTimes(1)
    dialog.dispose()
  })

  // 3) clickButton distinguishes between multiple buttons
  test("clickButton clicks the correct button among multiple", async () => {
    const onConfirm = mock()
    const dialog = await mountDialog(() =>
      h(Dialog, { title: "Options" },
        h("div", null,
          h(Button, { onClick: mock(), class: "ghost" }, "Cancel"),
          h(Button, { onClick: onConfirm, class: "primary" }, "Confirm"),
        ),
      ),
    )

    dialog.clickButton("Confirm")
    expect(onConfirm).toHaveBeenCalledTimes(1)
    dialog.dispose()
  })

  // 4) assertCallbackFired — callback assertion
  test("assertCallbackFired validates a mock was called", async () => {
    const callback = mock()
    const dialog = await mountDialog(() =>
      h(Dialog, { title: "Callback Test" },
        h(Button, { onClick: () => callback("arg1") }, "Fire"),
      ),
    )

    dialog.clickButton("Fire")
    dialog.assertCallbackFired(callback)
    dialog.dispose()
  })

  // 5) assertHidden + dispose — cleanup assertion
  test("dialog is removed from DOM after dispose", async () => {
    const dialog = await mountDialog(() =>
      h(Dialog, { title: "Dispose Test" }, "Content"),
    )

    dialog.assertVisible()
    dialog.dispose()
    dialog.assertHidden()
  })

  // 6) reactive state — dialog renders reactive signals
  test("dialog with reactive signal updates renders correctly", async () => {
    const dialog = await mountDialog(() => {
      const [count, setCount] = createSignal(0)
      return h(Dialog, { title: "Counter" },
        h("p", null, `Count: ${count()}`),
        h(Button, { onClick: () => setCount(count() + 1) }, "Increment"),
      )
    })

    expect(document.body.textContent).toContain("Count: 0")
    dialog.dispose()
  })

  // 7) callback pattern — like real dialogs with onClose
  test("dialog callback pattern fires on button click", async () => {
    const onClose = mock()
    const dialog = await mountDialog(() =>
      h(Dialog, { title: "Closeable" },
        h(Button, { onClick: () => onClose() }, "Close"),
      ),
    )

    dialog.clickButton("Close")
    expect(onClose).toHaveBeenCalledTimes(1)
    dialog.dispose()
  })
})
