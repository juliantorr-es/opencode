export const jumpThreshold = (el: HTMLDivElement): number => {
  return Math.max(0, el.scrollHeight - el.clientHeight - 200)
}

export function updateScrollState(
  el: HTMLDivElement,
  setScroll: (update: { overflow: boolean; bottom: boolean; jump: boolean }) => void,
): void {
  const { scrollTop, scrollHeight, clientHeight } = el
  const overflow = scrollHeight > clientHeight
  const bottom = scrollHeight - scrollTop - clientHeight <= 4
  const jump = scrollHeight - scrollTop - clientHeight <= jumpThreshold(el)
  setScroll({ overflow, bottom, jump })
}

export function scheduleScrollState(
  el: HTMLDivElement,
  frame: { value: number | undefined },
  target: { value: HTMLDivElement | undefined },
  onUpdate: (el: HTMLDivElement) => void,
): void {
  if (frame.value !== undefined) cancelAnimationFrame(frame.value)
  frame.value = requestAnimationFrame(() => {
    if (target.value) onUpdate(target.value)
    frame.value = undefined
  })
}

let gestureStart = 0

export function markScrollGesture(
  root: HTMLDivElement | undefined,
  setGesture: (ts: number) => void,
  target?: EventTarget | null,
): void {
  if (!root || !target) return
  if (root.contains(target as Node)) {
    gestureStart = Date.now()
    setGesture(gestureStart)
  }
}

export function hasScrollGesture(ts: number, windowMs: number): boolean {
  return Date.now() - ts < windowMs
}
