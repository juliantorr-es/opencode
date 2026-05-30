import { checksum } from "@opencode-ai/core/util/encode"
import type { JSX } from "solid-js"

export function openReviewPanel(view: { reviewPanel: { opened(): boolean; open(): void } }) {
  if (!view.reviewPanel.opened()) view.reviewPanel.open()
}

export function reviewDiffs(
  store: { changes: string },
  vcsQuery: { isFetched?: boolean; data?: unknown[] },
  turnDiffs: () => unknown[],
) {
  if (store.changes === "git" || store.changes === "branch")
    return vcsQuery.isFetched ? (vcsQuery.data ?? []) : []
  return turnDiffs()
}

export function reviewCount(
  store: { changes: string },
  vcsQuery: { isFetched?: boolean; data?: unknown[] },
  turnDiffs: () => unknown[],
) {
  return reviewDiffs(store, vcsQuery, turnDiffs).length
}

export function hasReview(
  store: { changes: string },
  vcsQuery: { isFetched?: boolean; data?: unknown[] },
  turnDiffs: () => unknown[],
) {
  return reviewCount(store, vcsQuery, turnDiffs) > 0
}

export function reviewReady(
  store: { changes: string },
  vcsQuery: { isPending?: boolean },
) {
  if (store.changes === "git" || store.changes === "branch") return !vcsQuery.isPending
  return true
}

export function reviewPanelLayout(content: JSX.Element) {
  return (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">{content}</div>
    </div>
  )
}

export function reviewDiffId(path: string) {
  const sum = checksum(path)
  if (!sum) return
  return `session-review-diff-${sum}`
}

export function reviewDiffTop(tree: { reviewScroll: HTMLElement | undefined }, path: string) {
  const root = tree.reviewScroll
  if (!root) return

  const id = reviewDiffId(path)
  if (!id) return

  const el = document.getElementById(id)
  if (!(el instanceof HTMLElement)) return
  if (!root.contains(el)) return

  const a = el.getBoundingClientRect()
  const b = root.getBoundingClientRect()
  return a.top - b.top + root.scrollTop
}

export function scrollToReviewDiff(
  tree: { reviewScroll: HTMLElement | undefined },
  view: { setScroll: (area: string, pos: { x: number; y: number }) => void },
  path: string,
) {
  const root = tree.reviewScroll
  if (!root) return false

  const top = reviewDiffTop(tree, path)
  if (top === undefined) return false

  view.setScroll("review", { x: root.scrollLeft, y: top })
  root.scrollTo({ top, behavior: "auto" })
  return true
}

export function focusReviewDiff(
  view: {
    reviewPanel: { opened(): boolean; open(): void }
    review: { openPath(path: string): void }
  },
  setTree: (update: Record<string, string | undefined>) => void,
  path: string,
) {
  openReviewPanel(view)
  view.review.openPath(path)
  setTree({ activeDiff: path, pendingDiff: path })
}
