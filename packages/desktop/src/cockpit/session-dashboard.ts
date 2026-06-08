/**
 * SessionDashboard — grid of SessionCards with filtering by status/agent.
 *
 * Binds to PGlite live queries via projection stream. Coexists with SolidJS
 * legacy renderer — this component registers as a custom element, not a
 * SolidJS component.
 *
 * Uses static `properties` instead of decorators for compat with the project's
 * TypeScript config (experimental decorators).
 */

import { LitElement, html, css, type TemplateResult } from "lit"
import { liveQuery } from "./projection-stream"

/* ── Types ──────────────────────────────────────────────── */

export interface SessionRecord {
  id: string
  agent: string
  status: "pending" | "active" | "completed" | "failed"
  startedAt: string | null
  completedAt: string | null
  summary: string | null
  tags: string[]
}

export type SessionFilter = {
  status?: SessionRecord["status"] | "all"
  agent?: string
}

/* ── SessionCard (internal) ─────────────────────────────── */

const cardStyles = css`
  :host {
    display: block;
  }

  .session-card {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs, 4px);
    padding: var(--spacing-md, 16px);
    background: var(--color-surface-raised, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius-md, 8px);
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: var(--font-size-sm, 13px);
    color: var(--color-text, #e0e0e0);
  }

  .session-card:hover {
    border-color: var(--color-accent, #4a9eff);
    box-shadow: var(--shadow-sm);
  }

  .session-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .session-agent {
    font-weight: var(--font-weight-semibold, 600);
    font-size: var(--font-size-md, 14px);
  }

  .session-status {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs, 4px);
    padding: 1px 6px;
    border-radius: var(--radius-sm, 4px);
    font-size: var(--font-size-xs, 11px);
    font-weight: var(--font-weight-medium, 500);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .session-status--pending {
    background: rgba(255, 193, 7, 0.15);
    color: #ffc107;
  }

  .session-status--active {
    background: rgba(74, 158, 255, 0.15);
    color: #4a9eff;
  }

  .session-status--completed {
    background: rgba(40, 199, 111, 0.15);
    color: #28c76f;
  }

  .session-status--failed {
    background: rgba(234, 84, 85, 0.15);
    color: #ea5455;
  }

  .session-time {
    font-size: var(--font-size-xs, 11px);
    color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
  }

  .session-summary {
    font-size: var(--font-size-sm, 13px);
    color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .session-tags {
    display: flex;
    gap: var(--spacing-xs, 4px);
    flex-wrap: wrap;
  }

  .session-tag {
    padding: 0 4px;
    font-size: var(--font-size-xs, 11px);
    background: var(--color-hover, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius-sm, 4px);
    color: var(--color-text-muted, rgba(255, 255, 255, 0.6));
  }
`

class SessionCard extends LitElement {
  static override styles = cardStyles

  static override properties = {
    session: { type: Object },
  }

  session?: SessionRecord

  private _formatTime(ts: string | null): string {
    if (!ts) return "-"
    const d = new Date(ts)
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  }

  override render(): TemplateResult {
    const s = this.session
    if (!s) return html``

    return html`
      <div class="session-card" @click=${this._onClick}>
        <div class="session-card-header">
          <span class="session-agent">${s.agent}</span>
          <span class="session-status session-status--${s.status}">${s.status}</span>
        </div>
        <div class="session-time">
          ${s.startedAt ? `Started ${this._formatTime(s.startedAt)}` : "Not started"}
          ${s.completedAt ? `\u00B7 Ended ${this._formatTime(s.completedAt)}` : ""}
        </div>
        ${s.summary ? html`<div class="session-summary">${s.summary}</div>` : ""}
        ${s.tags?.length ? html`
          <div class="session-tags">
            ${s.tags.map((t) => html`<span class="session-tag">${t}</span>`)}
          </div>
        ` : ""}
      </div>
    `
  }

  private _onClick(): void {
    this.dispatchEvent(new CustomEvent("session-select", {
      detail: { sessionId: this.session?.id },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define("cockpit-session-card", SessionCard)

/* ── SessionDashboard ───────────────────────────────────── */

export class SessionDashboard extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: var(--font-sans, system-ui, sans-serif);
      font-size: var(--font-size-sm, 13px);
      color: var(--color-text, #e0e0e0);
    }

    .filter-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
      border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
      flex-shrink: 0;
    }

    .filter-select {
      background: var(--color-surface-raised, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--radius-sm, 4px);
      color: var(--color-text, #e0e0e0);
      padding: 4px 8px;
      font-size: var(--font-size-sm, 13px);
      font-family: var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    .filter-input {
      flex: 1;
      background: var(--color-surface-raised, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--radius-sm, 4px);
      color: var(--color-text, #e0e0e0);
      padding: 4px 8px;
      font-size: var(--font-size-sm, 13px);
      font-family: var(--font-sans, system-ui, sans-serif);
    }

    .filter-input::placeholder {
      color: var(--color-text-muted, rgba(255, 255, 255, 0.4));
    }

    .filter-count {
      font-size: var(--font-size-xs, 11px);
      color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
      white-space: nowrap;
    }

    .session-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: var(--spacing-sm, 8px);
      padding: var(--spacing-md, 16px);
      overflow-y: auto;
      flex: 1;
      align-content: start;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--color-text-muted, rgba(255, 255, 255, 0.4));
      gap: var(--spacing-sm, 8px);
    }

    .empty-state-icon {
      font-size: 32px;
      opacity: 0.3;
    }

    .empty-state-text {
      font-size: var(--font-size-md, 14px);
    }
  `

  static override properties = {
    statusFilter: { type: String },
    agentFilter: { type: String },
  }

  statusFilter: string = "all"
  agentFilter: string = ""

  private _sessions: SessionRecord[] = []
  private _agents: string[] = []
  private _unsubscribe?: () => void

  override connectedCallback(): void {
    super.connectedCallback()
    this._subscribeToSessions()
    this._subscribeToAgents()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this._unsubscribe?.()
  }

  private _subscribeToSessions(): void {
    this._unsubscribe?.()
    this._unsubscribe = liveQuery<SessionRecord>(
      `SELECT id, agent, status, started_at AS startedAt, completed_at AS completedAt, summary, tags
       FROM sessions
       ORDER BY COALESCE(started_at, completed_at, 'now') DESC`,
      (rows) => {
        this._sessions = rows
        this.requestUpdate()
      },
    )
  }

  private _subscribeToAgents(): void {
    liveQuery<{ agent: string }>(
      `SELECT DISTINCT agent FROM sessions ORDER BY agent`,
      (rows) => {
        this._agents = rows.map((r) => r.agent)
      },
    )
  }

  private get _filtered(): SessionRecord[] {
    let list = this._sessions
    if (this.statusFilter !== "all") {
      list = list.filter((s) => s.status === this.statusFilter)
    }
    if (this.agentFilter) {
      list = list.filter((s) =>
        s.agent.toLowerCase().includes(this.agentFilter.toLowerCase()),
      )
    }
    return list
  }

  private _onStatusChange(e: Event): void {
    this.statusFilter = (e.target as HTMLSelectElement).value
    this.requestUpdate()
  }

  private _onAgentInput(e: Event): void {
    this.agentFilter = (e.target as HTMLInputElement).value
    this.requestUpdate()
  }

  override render(): TemplateResult {
    const filtered = this._filtered

    return html`
      <div class="filter-bar">
        <select class="filter-select" @change=${this._onStatusChange}>
          <option value="all" ?selected=${this.statusFilter === "all"}>All</option>
          <option value="active" ?selected=${this.statusFilter === "active"}>Active</option>
          <option value="pending" ?selected=${this.statusFilter === "pending"}>Pending</option>
          <option value="completed" ?selected=${this.statusFilter === "completed"}>Completed</option>
          <option value="failed" ?selected=${this.statusFilter === "failed"}>Failed</option>
        </select>
        <input
          class="filter-input"
          type="text"
          placeholder="Filter by agent..."
          .value=${this.agentFilter}
          @input=${this._onAgentInput}
        />
        <span class="filter-count">${filtered.length} session${filtered.length === 1 ? "" : "s"}</span>
      </div>

      ${filtered.length > 0
        ? html`
          <div class="session-grid">
            ${filtered.map(
              (s) => html`<cockpit-session-card .session=${s}></cockpit-session-card>`,
            )}
          </div>
        `
        : html`
          <div class="empty-state">
            <div class="empty-state-icon">○</div>
            <div class="empty-state-text">No sessions found</div>
          </div>
        `}
    `
  }
}

customElements.define("cockpit-session-dashboard", SessionDashboard)

export default SessionDashboard
