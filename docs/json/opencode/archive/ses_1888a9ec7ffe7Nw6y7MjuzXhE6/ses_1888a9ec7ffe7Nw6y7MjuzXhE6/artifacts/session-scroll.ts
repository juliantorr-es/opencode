export const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

export function updateScrollState(
  el: HTMLDivElement,
  setScroll: (update: { overflow: boolean; bottom: boolean; jump: boolean }) => void,
) {
  const max = el.scrollHeight - el.clientHeight
  const distance = max - el.scrollTop
  const overflow = max > 1
  const bottom = !overflow || distance <= 2
  const jump = overflow && distance > jumpThreshold(el)
  setScroll({ overflow, bottom, jump })
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

export function markScrollGesture(
  root: HTMLDivElement | undefined,
  setGesture: (ts: number) => void,
  target?: EventTarget | null,
) {
  if (!root) return
  const el = target instanceof Element ? target : undefined
  const nested = el?.closest("[data-scrollable]")
  if (nested && nested !== root) return
  setGesture(Date.now())
}

export function hasScrollGesture(ts: number, windowMs: number) {
  return Date.now() - ts < windowMs
}
