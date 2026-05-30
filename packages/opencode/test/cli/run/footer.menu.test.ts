import { expect, test } from "bun:test"
import { createRoot } from "solid-js"

const FOOTER_MENU_ROWS = 10
const createFooterMenuState = (..._args: any[]) => ({ move: (..._: any[]) => {}, selected: () => 0, offset: () => 0 }) as any

function mount(count: number, limit = FOOTER_MENU_ROWS) {
  let dispose!: () => void
  let menu!: ReturnType<typeof createFooterMenuState>

  createRoot((nextDispose) => {
    dispose = nextDispose
    menu = createFooterMenuState({ count: () => count, limit })
    return null
  })

  return { menu, dispose }
}

test("footer menu scrolls before the selected row hits the bottom edge", () => {
  const state = mount(20)

  try {
    Array.from({ length: 6 }).forEach(() => state.menu.move(1))

    expect(state.menu.selected()).toBe(6)
    expect(state.menu.offset()).toBe(1)
  } finally {
    state.dispose()
  }
})

test("footer menu scrolls before the selected row hits the top edge", () => {
  const state = mount(20)

  try {
    Array.from({ length: 13 }).forEach(() => state.menu.move(1))
    Array.from({ length: 4 }).forEach(() => state.menu.move(-1))

    expect(state.menu.selected()).toBe(9)
    expect(state.menu.offset()).toBe(7)
  } finally {
    state.dispose()
  }
})
