import { performance } from "node:perf_hooks"

export type ReviewExportTimingKeyV1 =
  | "discover"
  | "index"
  | "semantic_artifacts"
  | "semantic_zip"
  | "source_zip"
  | "verify"
  | "complete"
  | "load_or_build_snapshot"

export type ReviewExportStageV1 = Exclude<ReviewExportTimingKeyV1, "load_or_build_snapshot">

export type ReviewExportTimingsV1 = Partial<Record<ReviewExportTimingKeyV1, number>>

type ReviewExportProgressBaseV1 = {
  message?: string
  timings_ms?: ReviewExportTimingsV1
  files_seen?: number
  files_indexed?: number
  artifact?: string
  bytes_written?: number
  entries_written?: number
  check?: string
  semantic_zip?: string
  source_zip?: string
  warnings_count?: number
  critical_count?: number
}

export type ReviewExportProgressEventV1 =
  | (ReviewExportProgressBaseV1 & {
      stage: "discover"
      status: "start" | "progress" | "done"
    })
  | (ReviewExportProgressBaseV1 & {
      stage: "index"
      status: "start" | "progress" | "done"
    })
  | (ReviewExportProgressBaseV1 & {
      stage: "semantic_artifacts"
      status: "start" | "progress" | "done"
    })
  | (ReviewExportProgressBaseV1 & {
      stage: "semantic_zip"
      status: "start" | "progress" | "done"
    })
  | (ReviewExportProgressBaseV1 & {
      stage: "source_zip"
      status: "start" | "progress" | "done"
    })
  | (ReviewExportProgressBaseV1 & {
      stage: "verify"
      status: "start" | "progress" | "done"
    })
  | (ReviewExportProgressBaseV1 & {
      stage: "complete"
      status: "done"
    })

export type ReviewExportProgressSinkV1 = (event: ReviewExportProgressEventV1) => void

export function createReviewExportTimeline(progress?: ReviewExportProgressSinkV1) {
  const timings: ReviewExportTimingsV1 = {}

  const emit = (event: ReviewExportProgressEventV1): void => {
    progress?.(event)
  }

  const start = <T extends ReviewExportStageV1>(
    stage: T,
    event: Omit<Extract<ReviewExportProgressEventV1, { stage: T }>, "stage" | "status" | "timings_ms"> & {
      status?: "start" | "progress" | "done"
    } = {},
  ) => {
    emit({ stage, status: event.status ?? "start", ...event } as ReviewExportProgressEventV1)
    const started = performance.now()
    return (next: Omit<Extract<ReviewExportProgressEventV1, { stage: T }>, "stage" | "status" | "timings_ms"> = {}, status: "progress" | "done" = "done") => {
      timings[stage] = Math.max(0, Math.round(performance.now() - started))
      emit({ stage, status, ...next, timings_ms: { ...timings } } as ReviewExportProgressEventV1)
      return timings[stage] ?? 0
    }
  }

  const mark = (stage: ReviewExportTimingKeyV1, durationMs: number): void => {
    timings[stage] = Math.max(0, Math.round(durationMs))
  }

  const snapshot = (): ReviewExportTimingsV1 => ({ ...timings })

  return { emit, start, mark, snapshot, timings }
}

export function formatReviewExportProgress(event: ReviewExportProgressEventV1): string {
  const prefix = `[${event.stage}]`
  const suffix = (() => {
    if (event.stage === "discover") {
      if (event.status === "start") return "starting discovery"
      if (typeof event.files_seen === "number") return `${event.files_seen} file(s) seen`
      return "discovery complete"
    }
    if (event.stage === "index") {
      if (event.status === "start") return "building index"
      if (typeof event.files_indexed === "number") return `${event.files_indexed} file(s) indexed`
      return "index complete"
    }
    if (event.stage === "semantic_artifacts") {
      if (event.status === "start") return "writing semantic artifacts"
      if (event.artifact) return `wrote ${event.artifact}`
      return "semantic artifacts complete"
    }
    if (event.stage === "semantic_zip") {
      if (event.status === "start") return "packing semantic zip"
      const entryText = typeof event.entries_written === "number" ? `${event.entries_written} entr${event.entries_written === 1 ? "y" : "ies"}` : "zip complete"
      return typeof event.bytes_written === "number" ? `${entryText}, ${event.bytes_written} byte(s)` : entryText
    }
    if (event.stage === "source_zip") {
      if (event.status === "start") return "packing source zip"
      const entryText = typeof event.entries_written === "number" ? `${event.entries_written} entr${event.entries_written === 1 ? "y" : "ies"}` : "zip complete"
      return typeof event.bytes_written === "number" ? `${entryText}, ${event.bytes_written} byte(s)` : entryText
    }
    if (event.stage === "verify") {
      if (event.status === "start") return "verifying packet integrity"
      return event.check ?? "verification complete"
    }
    if (event.stage === "complete") {
      return "export complete"
    }
    return event.message ?? event.status
  })()

  const timing = event.timings_ms ? Object.entries(event.timings_ms).map(([stage, ms]) => `${stage}=${ms}ms`).join(", ") : ""
  return timing ? `${prefix} ${suffix} (${timing})` : `${prefix} ${suffix}`
}

