import { type JSX } from "solid-js"

export function openReviewPanel(view: {
  reviewPanel: { opened(): boolean; open(): void }
}): void {
  if (!view.reviewPanel.opened()) {
    view.reviewPanel.open()
  }
}

export function reviewDiffs<T>(
  store: { changes: string },
  vcsQuery: { isFetched?: boolean; data?: T[] },
  turnDiffs: () => T[],
): T[] {
  if (store.changes === "git" || store.changes === "branch") {
    return vcsQuery.data ?? []
  }
  return turnDiffs()
}

export function reviewCount<T>(
  store: { changes: string },
  vcsQuery: { isFetched?: boolean; data?: T[] },
  turnDiffs: () => T[],
): number {
  return reviewDiffs(store, vcsQuery, turnDiffs).length
}

export function hasReview<T>(
  store: { changes: string },
  vcsQuery: { isFetched?: boolean; data?: T[] },
  turnDiffs: () => T[],
): boolean {
  return reviewCount(store, vcsQuery, turnDiffs) > 0
}

export function reviewReady(
  store: { changes: string },
  vcsQuery: { isPending?: boolean },
): boolean {
  if (store.changes === "git" || store.changes === "branch") {
    return !vcsQuery.isPending
  }
  return true
}

export function reviewPanelLayout(content: JSX.Element): JSX.Element {
  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="flex-1 overflow-auto">{content}</div>
    </div>
  )
}

export function reviewDiffId(path: string): string | undefined {
  if (!path) return undefined
  return `review-diff-${path.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

export function reviewDiffTop(
  tree: { reviewScroll: HTMLElement | undefined },
  path: string,
): number | undefined {
  const id = reviewDiffId(path)
  if (!id) return undefined
  const el = tree.reviewScroll?.querySelector(`[data-diff-id="${id}"]`)
  if (!el) return undefined
  return (el as HTMLElement).offsetTop
}

export function scrollToReviewDiff(
  tree: { reviewScroll: HTMLElement | undefined },
  view: unknown,
  path: string,
): boolean {
  const top = reviewDiffTop(tree, path)
  if (top === undefined) return false
  tree.reviewScroll?.scrollTo({ top, behavior: "smooth" })
  return true
}

export function focusReviewDiff(
  view: unknown,
  setTree: (...args: any[]) => void,
  path: string,
): void {
}
