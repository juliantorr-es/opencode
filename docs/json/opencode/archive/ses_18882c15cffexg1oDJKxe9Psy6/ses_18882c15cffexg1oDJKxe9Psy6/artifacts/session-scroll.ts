export const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

export function updateScrollState(
  el: HTMLDivElement,
  ui: { scroll: { overflow: boolean; bottom: boolean; jump: boolean } },
  setUi: (key: string, value: { overflow: boolean; bottom: boolean; jump: boolean }) => void,
) {
  const max = el.scrollHeight - el.clientHeight
  const distance = max - el.scrollTop
  const overflow = max > 1
  const bottom = !overflow || distance <= 2
  const jump = overflow && distance > jumpThreshold(el)
  if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
  setUi("scroll", { overflow, bottom, jump })
}

export function scheduleScrollState(
  el: HTMLDivElement,
  frame: { value: number | undefined },
  target: { value: HTMLDivElement | undefined },
  onUpdate: (el: HTMLDivElement) => void,
) {
  target.value = el
  if (frame.value !== undefined) return
  frame.value = requestAnimationFrame(() => {
    frame.value = undefined
    const t = target.value
    target.value = undefined
    if (!t) return
    onUpdate(t)
  })
}

export function resumeScroll(
  setMessageId: (id: string | undefined) => void,
  forceScrollToBottom: () => void,
  clearMessageHash: () => void,
  scroller: HTMLDivElement | undefined,
  schedule: (el: HTMLDivElement) => void,
) {
  setMessageId(undefined)
  forceScrollToBottom()
  clearMessageHash()
  if (scroller) schedule(scroller)
}

export function setScrollRef(
  el: HTMLDivElement | undefined,
  scroller: { value: HTMLDivElement | undefined },
  setScrollerRef: (el: HTMLDivElement | undefined) => void,
  schedule: (el: HTMLDivElement) => void,
  fill: () => void,
) {
  scroller.value = el
  setScrollerRef(el)
  if (!el) return
  schedule(el)
  fill()
}

export function markScrollGesture(
  scroller: HTMLDivElement | undefined,
  setUi: (key: string, value: number) => void,
  target?: EventTarget | null,
) {
  const root = scroller
  if (!root) return

  const el = target instanceof Element ? target : undefined
  const nested = el?.closest("[data-scrollable]")
  if (nested && nested !== root) return

  setUi("scrollGesture", Date.now())
}

export function hasScrollGesture(
  ui: { scrollGesture: number },
  windowMs: number,
) {
  return Date.now() - ui.scrollGesture < windowMs
}
