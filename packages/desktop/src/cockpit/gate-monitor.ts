/**
 * GateMonitor — real-time gate evaluation feed with pass/fail/pending indicators.
 *
 * Shows a reverse-chronological feed of gate evaluations. Each gate check
 * displays the gate name, rule, status indicator, and optional message.
 * Binds to PGlite live queries for real-time updates.
 *
 * Uses static `properties` instead of decorators for compat with the project's
 * TypeScript config (experimental decorators).
 */

import { LitElement, html, css, type TemplateResult } from "lit"
import { liveQuery } from "./projection-stream"

/* ── Types ──────────────────────────────────────────────── */

export interface GateEvaluation {
  id: string
  gateId: string
  gateName: string
  rule: string
  status: "pass" | "fail" | "pending" | "error"
  evaluatedAt: string
  evaluatedBy: string | null
  message: string | null
  durationMs: number | null
  sessionId: string | null
}

export type GateFilter = "all" | "pass" | "fail" | "pending" | "error"

/* ── GateMonitor ────────────────────────────────────────── */

export class GateMonitor extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: var(--font-sans, system-ui, sans-serif);
      font-size: var(--font-size-sm, 13px);
      color: var(--color-text, #e0e0e0);
      overflow: hidden;
    }

    .feed-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
      border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
      flex-shrink: 0;
    }

    .feed-filters {
      display: flex;
      gap: var(--spacing-xs, 4px);
    }

    .feed-filter-btn {
      padding: 2px 10px;
      border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--radius-full, 9999px);
      background: transparent;
      color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
      font-size: var(--font-size-xs, 11px);
      font-family: var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
      transition: all 0.15s;
    }

    .feed-filter-btn:hover {
      border-color: var(--color-accent, #4a9eff);
      color: var(--color-text, #e0e0e0);
    }

    .feed-filter-btn.active {
      background: var(--color-accent, #4a9eff);
      border-color: var(--color-accent, #4a9eff);
      color: #fff;
    }

    .feed-summary {
      margin-left: auto;
      display: flex;
      gap: var(--spacing-md, 16px);
      font-size: var(--font-size-xs, 11px);
      color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
    }

    .feed-summary-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .feed-summary-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .feed-scroll {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-xs, 4px) 0;
    }

    .gate-entry {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
      border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.04));
      transition: background 0.1s;
    }

    .gate-entry:hover {
      background: var(--color-hover, rgba(255, 255, 255, 0.03));
    }

    .gate-indicator {
      flex-shrink: 0;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-top: 4px;
      position: relative;
    }

    .gate-indicator--pass {
      background: #28c76f;
      box-shadow: 0 0 6px rgba(40, 199, 111, 0.4);
    }

    .gate-indicator--fail {
      background: #ea5455;
      box-shadow: 0 0 6px rgba(234, 84, 85, 0.4);
    }

    .gate-indicator--pending {
      background: #ffc107;
      box-shadow: 0 0 6px rgba(255, 193, 7, 0.4);
      animation: pulse 1.5s ease-in-out infinite;
    }

    .gate-indicator--error {
      background: #ff8800;
      box-shadow: 0 0 6px rgba(255, 136, 0, 0.4);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .gate-content {
      flex: 1;
      min-width: 0;
    }

    .gate-name {
      font-size: var(--font-size-md, 14px);
      font-weight: var(--font-weight-medium, 500);
      margin: 0 0 2px 0;
    }

    .gate-rule {
      font-size: var(--font-size-xs, 11px);
      color: var(--color-text-secondary, rgba(255, 255, 255, 0.6));
      font-family: var(--font-mono, ui-monospace, monospace);
      margin: 0 0 4px 0;
    }

    .gate-message {
      font-size: var(--font-size-xs, 11px);
      color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .gate-time {
      font-size: var(--font-size-xs, 11px);
      color: var(--color-text-muted, rgba(255, 255, 255, 0.35));
      white-space: nowrap;
      flex-shrink: 0;
      padding-top: 4px;
    }

    .gate-badge {
      display: inline-block;
      padding: 0 4px;
      border-radius: var(--radius-sm, 4px);
      font-size: 10px;
      font-weight: var(--font-weight-medium, 500);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-left: auto;
      flex-shrink: 0;
    }

    .gate-badge--pass {
      background: rgba(40, 199, 111, 0.15);
      color: #28c76f;
    }

    .gate-badge--fail {
      background: rgba(234, 84, 85, 0.15);
      color: #ea5455;
    }

    .gate-badge--pending {
      background: rgba(255, 193, 7, 0.15);
      color: #ffc107;
    }

    .gate-badge--error {
      background: rgba(255, 136, 0, 0.15);
      color: #ff8800;
    }

    .empty-feed {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-xl, 32px);
      color: var(--color-text-muted, rgba(255, 255, 255, 0.3));
      gap: var(--spacing-xs, 4px);
    }

    .empty-feed-icon {
      font-size: 24px;
      opacity: 0.3;
    }
  `

  static override properties = {
    filter: { type: String },
    maxEntries: { type: Number },
  }

  filter: GateFilter = "all"
  maxEntries: number = 200

  private _evaluations: GateEvaluation[] = []
  private _unsubscribe?: () => void

  override connectedCallback(): void {
    super.connectedCallback()
    this._subscribe()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this._unsubscribe?.()
  }

  private _subscribe(): void {
    this._unsubscribe?.()
    this._unsubscribe = liveQuery<GateEvaluation>(
      `SELECT
        ge.id,
        ge.gate_id AS gateId,
        COALESCE(g.name, ge.gate_id) AS gateName,
        ge.rule,
        ge.status,
        ge.evaluated_at AS evaluatedAt,
        ge.evaluated_by AS evaluatedBy,
        ge.message,
        ge.duration_ms AS durationMs,
        ge.session_id AS sessionId
      FROM gate_evaluations ge
      LEFT JOIN gates g ON g.id = ge.gate_id
      ORDER BY ge.evaluated_at DESC
      LIMIT ${Math.max(50, this.maxEntries)}`,
      (rows) => {
        this._evaluations = rows
        this.requestUpdate()
      },
    )
  }

  private get _filtered(): GateEvaluation[] {
    if (this.filter === "all") return this._evaluations
    return this._evaluations.filter((e) => e.status === this.filter)
  }

  private get _summary(): { total: number; pass: number; fail: number; pending: number; error: number } {
    const e = this._evaluations
    return {
      total: e.length,
      pass: e.filter((x) => x.status === "pass").length,
      fail: e.filter((x) => x.status === "fail").length,
      pending: e.filter((x) => x.status === "pending").length,
      error: e.filter((x) => x.status === "error").length,
    }
  }

  private _onFilterClick(f: GateFilter): void {
    this.filter = f
    this.requestUpdate()
  }

  private _formatTime(ts: string): string {
    const d = new Date(ts)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffSec = Math.floor(diffMs / 1000)
    if (diffSec < 5) return "just now"
    if (diffSec < 60) return `${diffSec}s ago`
    const diffMin = Math.floor(diffSec / 60)
    if (diffMin < 60) return `${diffMin}m ago`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h ago`
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  }

  override render(): TemplateResult {
    const items = this._filtered
    const summary = this._summary
    const filters: { key: GateFilter; label: string }[] = [
      { key: "all", label: "All" },
      { key: "pass", label: "Pass" },
      { key: "fail", label: "Fail" },
      { key: "pending", label: "Pending" },
      { key: "error", label: "Error" },
    ]

    return html`
      <div class="feed-header">
        <div class="feed-filters">
          ${filters.map(
            (f) => html`
              <button
                class="feed-filter-btn ${this.filter === f.key ? "active" : ""}"
                @click=${() => this._onFilterClick(f.key)}
              >${f.label}</button>
            `,
          )}
        </div>
        <div class="feed-summary">
          <span class="feed-summary-item">
            <span class="feed-summary-dot" style="background:#28c76f"></span>
            ${summary.pass}
          </span>
          <span class="feed-summary-item">
            <span class="feed-summary-dot" style="background:#ea5455"></span>
            ${summary.fail}
          </span>
          <span class="feed-summary-item">
            <span class="feed-summary-dot" style="background:#ffc107"></span>
            ${summary.pending}
          </span>
        </div>
      </div>

      <div class="feed-scroll">
        ${items.length > 0
          ? items.map(
              (g) => html`
                <div class="gate-entry">
                  <div class="gate-indicator gate-indicator--${g.status}"></div>
                  <div class="gate-content">
                    <div class="gate-name">${g.gateName}</div>
                    <div class="gate-rule">${g.rule}</div>
                    ${g.message ? html`<div class="gate-message">${g.message}</div>` : ""}
                  </div>
                  <span class="gate-badge gate-badge--${g.status}">${g.status}</span>
                  <span class="gate-time">${this._formatTime(g.evaluatedAt)}</span>
                </div>
              `,
            )
          : html`
            <div class="empty-feed">
              <div class="empty-feed-icon">◉</div>
              <div>No gate evaluations</div>
            </div>
          `}
      </div>
    `
  }
}

customElements.define("cockpit-gate-monitor", GateMonitor)

export default GateMonitor
