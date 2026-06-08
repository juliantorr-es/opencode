// OpenTelemetry Trace Integration
// Instruments cross-runtime boundaries: sidecar boot, project activation,
// tool invocation, session creation, migration runs, projection rebuilds.

import type { Span } from "@opentelemetry/api"
import { trace, SpanStatusCode } from "@opentelemetry/api"

const tracer = trace.getTracer("opencode-desktop")

// ── Span Helpers ──────────────────────────────────────────

export function startSpan(name: string, attrs?: Record<string, string | number>) {
  const span = tracer.startSpan(name)
  if (attrs) span.setAttributes(attrs)
  return span
}

export function endSpan(span: Span, error?: unknown) {
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
    span.recordException(error instanceof Error ? error : new Error(String(error)))
  }
  span.end()
}

// ── Named Spans ───────────────────────────────────────────

export const TraceSpans = {
  // Sidecar lifecycle
  desktopLaunch: (version: string) => startSpan("desktop.launch", { version }),
  sidecarSpawn: (port: number) => startSpan("sidecar.spawn", { port }),
  sidecarReady: () => startSpan("sidecar.ready"),

  // Storage
  pgliteOpen: (dataDir: string) => startSpan("pglite.open", { dataDir }),
  migrationsRun: (count: number) => startSpan("migrations.run", { count }),
  projectionInit: (name: string) => startSpan("projection.init", { name }),
  projectionRebuild: (name: string) => startSpan("projection.rebuild", { name }),

  // Frontend
  rendererAwaitInit: () => startSpan("renderer.awaitInitialization"),
  globalBootstrap: () => startSpan("global.bootstrap"),

  // Project
  projectActivate: (directory: string) => startSpan("project.activate", { "project.dir": directory }),
  instanceBoot: (directory: string) => startSpan("project.instance.boot", { "project.dir": directory }),
  contextLoad: (directory: string) => startSpan("project.context.load", { "project.dir": directory }),

  // Session
  sessionCreate: (directory: string) => startSpan("session.create", { "project.dir": directory }),

  // Tool
  toolInvoke: (tool: string) => startSpan("tool.invoke", { "tool.name": tool }),
}
