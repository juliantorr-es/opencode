import { Effect, Console } from "effect"
import { GlobalBus } from "@/bus/global"
import * as CoordEvents from "./coord-events"

// --- Types ---

export type FragmentRegistration = {
  fragmentId: string
  laneId: string
  sessionId: string
  targetFile: string
  fragmentType: string
  anchorHint: string | null
  orderHint: string | null
  content: string
  registeredAt: number
}

export type CollisionInfo = {
  targetFile: string
  conflictingFragmentId: string
  conflictingLaneId: string
  anchorOverlap: string
  severity: "info" | "warning" | "collision"
}

// --- In-memory fragment tracking ---

const activeFragments = new Map<string, FragmentRegistration[]>()

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, "/")
}

function getFileFragments(targetFile: string): FragmentRegistration[] {
  const key = normalizePath(targetFile)
  return activeFragments.get(key) ?? []
}

function setFileFragments(targetFile: string, fragments: FragmentRegistration[]): void {
  const key = normalizePath(targetFile)
  if (fragments.length === 0) {
    activeFragments.delete(key)
  } else {
    activeFragments.set(key, fragments)
  }
}

// --- Anchor overlap heuristics ---

/**
 * Simple heuristic to determine if two anchor_hints might overlap.
 *
 * - If both have numeric line numbers, compute numeric distance.
 * - If both have named anchors (like "after last import", "before return"),
 *   they overlap if they reference the same broad region.
 * - If one is numeric and the other is named, conservatively flag as overlap
 *   (named anchors are imprecise).
 * - Returns "compatible" if anchors are clearly non-overlapping.
 */
function assessAnchorOverlap(
  hintA: string | null,
  hintB: string | null,
): "compatible" | "overlap" | "unknown" {
  if (hintA === null || hintB === null) return "unknown"

  // Both are numeric line anchors
  const lineA = parseNumericLine(hintA)
  const lineB = parseNumericLine(hintB)
  if (lineA !== null && lineB !== null) {
    const distance = Math.abs(lineA - lineB)
    // Lines more than 50 apart are likely non-overlapping regions
    return distance > 50 ? "compatible" : "overlap"
  }

  // Named anchor comparison — group into broad regions
  const regionA = classifyNamedAnchor(hintA)
  const regionB = classifyNamedAnchor(hintB)
  if (regionA !== null && regionB !== null) {
    return regionA === regionB ? "overlap" : "compatible"
  }

  // Mixed: one numeric, one named — conservatively flag
  return "unknown"
}

function parseNumericLine(hint: string): number | null {
  const match = hint.match(/(?:line\s*)?(\d+)/i)
  return match ? parseInt(match[1]!, 10) : null
}

function classifyNamedAnchor(hint: string): "imports" | "exports" | "body_return" | "body_top" | "body_end" | "switch" | null {
  const h = hint.toLowerCase()
  if (h.includes("after last import") || h.includes("after import") || h.includes("import section")) return "imports"
  if (h.includes("before return") || h.includes("before the return") || h.includes("return statement")) return "body_return"
  if (h.includes("before export") || h.includes("export section")) return "exports"
  if (h.includes("top of") || h.includes("beginning") || h.includes("first")) return "body_top"
  if (h.includes("end of") || h.includes("bottom") || h.includes("last")) return "body_end"
  if (h.includes("inside switch") || h.includes("case") || h.includes("switch")) return "switch"
  return null
}

function severityFromOverlap(overlap: string): CollisionInfo["severity"] {
  if (overlap === "overlap") return "collision"
  if (overlap === "unknown") return "warning"
  return "info"
}

// --- Public API ---

/**
 * Register a fragment in the in-memory tracker.
 * Also checks for collisions against existing registrations.
 * Returns any collisions found.
 */
export const registerFragment = Effect.fn("Contention.registerFragment")(function* (
  fragmentId: string,
  laneId: string,
  sessionId: string,
  targetFile: string,
  fragmentType: string,
  anchorHint: string | null,
  orderHint: string | null,
  content: string,
) {
  const registration: FragmentRegistration = {
    fragmentId,
    laneId,
    sessionId,
    targetFile,
    fragmentType,
    anchorHint,
    orderHint,
    content,
    registeredAt: Date.now(),
  }

  const existing = getFileFragments(targetFile)
  const collisions: CollisionInfo[] = []

  for (const existingFrag of existing) {
    const overlap = assessAnchorOverlap(anchorHint, existingFrag.anchorHint)
    const severity = severityFromOverlap(overlap)

    if (overlap !== "compatible") {
      const info: CollisionInfo = {
        targetFile,
        conflictingFragmentId: existingFrag.fragmentId,
        conflictingLaneId: existingFrag.laneId,
        anchorOverlap: overlap,
        severity,
      }
      collisions.push(info)
    }
  }

  // Register
  setFileFragments(targetFile, [...existing, registration])

  // Emit Bus event for each collision found (advisory, not blocking)
  if (collisions.length > 0) {
    yield* Effect.sync(() => {
      for (const col of collisions) {
        GlobalBus.emit("event", {
          payload: {
            type: "coordination.fragment_contention",
            properties: {
              session_id: sessionId,
              target_file: col.targetFile,
              conflicting_fragment_id: col.conflictingFragmentId,
              conflicting_lane_id: col.conflictingLaneId,
              anchor_overlap: col.anchorOverlap,
              severity: col.severity,
              detected_at: Date.now(),
            },
          },
        })
      }
    })
  }

  return collisions
})

/**
 * Remove a fragment from the in-memory tracker.
 */
export const releaseFragment = Effect.fn("Contention.releaseFragment")(function* (
  fragmentId: string,
  targetFile: string,
) {
  const existing = getFileFragments(targetFile)
  const filtered = existing.filter((f) => f.fragmentId !== fragmentId)
  setFileFragments(targetFile, filtered)
})

/**
 * Detect contention for a potential new fragment without registering it.
 * Useful for "dry run" checks.
 */
export const detectContention = Effect.fn("Contention.detectContention")(function* (
  targetFile: string,
  anchorHint: string | null,
  laneId: string,
) {
  const existing = getFileFragments(targetFile)
  const collisions: CollisionInfo[] = []

  for (const existingFrag of existing) {
    if (existingFrag.laneId === laneId) continue // don't flag self

    const overlap = assessAnchorOverlap(anchorHint, existingFrag.anchorHint)
    const severity = severityFromOverlap(overlap)

    if (overlap !== "compatible") {
      collisions.push({
        targetFile,
        conflictingFragmentId: existingFrag.fragmentId,
        conflictingLaneId: existingFrag.laneId,
        anchorOverlap: overlap,
        severity,
      })
    }
  }

  return collisions
})

/**
 * Get all current collisions across all tracked files.
 */
export const getCollisions = Effect.fn("Contention.getCollisions")(function* () {
  const result: Array<{ targetFile: string; collisions: CollisionInfo[] }> = []

  for (const [key, fragments] of activeFragments.entries()) {
    if (fragments.length < 2) continue
    const fileCollisions: CollisionInfo[] = []
    for (let i = 0; i < fragments.length; i++) {
      for (let j = i + 1; j < fragments.length; j++) {
        const a = fragments[i]!
        const b = fragments[j]!
        const overlap = assessAnchorOverlap(a.anchorHint, b.anchorHint)
        const severity = severityFromOverlap(overlap)
        if (overlap !== "compatible") {
          fileCollisions.push({
            targetFile: a.targetFile,
            conflictingFragmentId: b.fragmentId,
            conflictingLaneId: b.laneId,
            anchorOverlap: overlap,
            severity,
          })
        }
      }
    }
    if (fileCollisions.length > 0) {
      result.push({ targetFile: key, collisions: fileCollisions })
    }
  }

  return result
})

export * as Contention from "./contention"
