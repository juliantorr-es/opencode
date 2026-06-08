/**
 * MissionBoard — kanban-style board with MissionCards grouped by status.
 *
 * Three columns: not_started, in_progress, completed, blocked. Each column
 * renders cards bound to PGlite live queries. Designed for the cockpit panel
 * system alongside the legacy SolidJS renderer.
 *
 * Uses static `properties` instead of decorators for compat with the project's
 * TypeScript config (experimental decorators).
 */

import { LitElement, html, css, type TemplateResult } from "lit"
import { liveQuery } from "./projection-stream"

/* ── Types ──────────────────────────────────────────────── */

export interface MissionRecord {
  id: string
  title: string
  description: string | null
  status: "not_started" | "in_progress" | "completed" | "blocked" | "abandoned"
  priority: number
  campaignId: string
  startedAt: string | null
  completedAt: string | null
  tags: string[]
  laneCount: number
  taskCount: number
  completedTaskCount: number
}

export type KanbanColumn = "not_started" | "in_progress" | "completed" | "blocked"

/* ── Mission Card ───────────────────────────────────────── */

const cardStyles = css`
  :host {
    display: block;
  }

  .mission-card {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs, 4px);
    padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
    background: var(--color-surface-raised, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius-md, 8px);
    cursor: pointer;
    transition: border-color 0.15s, transform 0.1s;
    font-family: var(--font-sans, system-ui, sans-serif);
    color: var(--color-text, #e0e0e0);
  }

  .mission-card:hover {
    border-color: var(--color-accent, #4a9eff);
    transform: translateY(-1px);
  }

  .mission-title {
    font-size: var(--font-size-md, 14px);
    font-weight: var(--font-weight-semibold, 600);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mission-description {
    font-size: var(--font-size-sm, 13px);
    color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .mission-meta {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 8px);
    font-size: var(--font-size-xs, 11px);
    color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
  }

  .mission-priority {
    padding: 0 4px;
    border-radius: var(--radius-sm, 4px);
    font-weight: var(--font-weight-medium, 500);
  }

  .mission-priority--high {
    background: rgba(234, 84, 85, 0.15);
    color: #ea5455;
  }

  .mission-priority--medium {
    background: rgba(255, 193, 7, 0.15);
    color: #ffc107;
  }

  .mission-priority--low {
    background: rgba(40, 199, 111, 0.15);
    color: #28c76f;
  }

  .mission-progress {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs, 4px);
  }

  .mission-progress-bar {
    width: 48px;
    height: 4px;
    background: var(--color-hover, rgba(255, 255, 255, 0.08));
    border-radius: 2px;
    overflow: hidden;
  }

  .mission-progress-fill {
    height: 100%;
    background: var(--color-accent, #4a9eff);
    border-radius: 2px;
    transition: width 0.3s;
  }
`

class MissionCard extends LitElement {
  static override styles = cardStyles

  static override properties = {
    mission: { type: Object },
  }

  mission?: MissionRecord

  private _priorityLabel(p: number): { label: string; cls: string } {
    if (p >= 70) return { label: "High", cls: "high" }
    if (p >= 40) return { label: "Med", cls: "medium" }
    return { label: "Low", cls: "low" }
  }

  override render(): TemplateResult {
    const m = this.mission
    if (!m) return html``

    const pri = this._priorityLabel(m.priority)
    const pct = m.taskCount > 0 ? Math.round((m.completedTaskCount / m.taskCount) * 100) : 0

    return html`
      <div class="mission-card" @click=${this._onClick}>
        <div class="mission-title">${m.title}</div>
        ${m.description ? html`<div class="mission-description">${m.description}</div>` : ""}
        <div class="mission-meta">
          <span class="mission-priority mission-priority--${pri.cls}">${pri.label}</span>
          <span>${m.laneCount} lane${m.laneCount === 1 ? "" : "s"}</span>
          <span class="mission-progress">
            <span>${m.completedTaskCount}/${m.taskCount}</span>
            <span class="mission-progress-bar">
              <span class="mission-progress-fill" style="width:${pct}%"></span>
            </span>
          </span>
        </div>
      </div>
    `
  }

  private _onClick(): void {
    this.dispatchEvent(new CustomEvent("mission-select", {
      detail: { missionId: this.mission?.id },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define("cockpit-mission-card", MissionCard)

/* ── Column ─────────────────────────────────────────────── */

const columnDefs: { key: KanbanColumn; label: string; color: string }[] = [
  { key: "not_started", label: "Not Started", color: "#ffc107" },
  { key: "in_progress", label: "In Progress", color: "#4a9eff" },
  { key: "blocked", label: "Blocked", color: "#ea5455" },
  { key: "completed", label: "Completed", color: "#28c76f" },
]

/* ── MissionBoard ───────────────────────────────────────── */

export class MissionBoard extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: var(--font-sans, system-ui, sans-serif);
      color: var(--color-text, #e0e0e0);
    }

    .board-scroll {
      display: flex;
      gap: var(--spacing-md, 16px);
      padding: var(--spacing-md, 16px);
      overflow-x: auto;
      flex: 1;
      min-height: 0;
    }

    .column {
      display: flex;
      flex-direction: column;
      min-width: 260px;
      max-width: 320px;
      flex-shrink: 0;
      background: var(--color-surface, rgba(0, 0, 0, 0.15));
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
    }

    .column-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
      font-size: var(--font-size-sm, 13px);
      font-weight: var(--font-weight-semibold, 600);
      border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
      flex-shrink: 0;
    }

    .column-count {
      font-size: var(--font-size-xs, 11px);
      font-weight: var(--font-weight-normal, 400);
      color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
      background: var(--color-hover, rgba(255, 255, 255, 0.06));
      padding: 0 6px;
      border-radius: var(--radius-sm, 4px);
    }

    .column-body {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs, 4px);
      padding: var(--spacing-sm, 8px);
      overflow-y: auto;
      flex: 1;
    }

    .empty-column {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-lg, 24px);
      color: var(--color-text-muted, rgba(255, 255, 255, 0.3));
      font-size: var(--font-size-sm, 13px);
      font-style: italic;
    }
  `

  static override properties = {
    campaignId: { type: String },
  }

  campaignId = ""

  private _missions: MissionRecord[] = []
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
    const where = this.campaignId
      ? `WHERE campaign_id = '${this.campaignId.replace(/'/g, "''")}'`
      : ""
    this._unsubscribe = liveQuery<MissionRecord>(
      `SELECT
        m.id,
        m.title,
        m.description,
        m.status,
        m.priority,
        m.campaign_id AS campaignId,
        m.started_at AS startedAt,
        m.completed_at AS completedAt,
        m.tags,
        (SELECT COUNT(*) FROM lanes l WHERE l.mission_id = m.id) AS laneCount,
        (SELECT COUNT(*) FROM tasks t WHERE t.mission_id = m.id) AS taskCount,
        (SELECT COUNT(*) FROM tasks t WHERE t.mission_id = m.id AND t.status = 'completed') AS completedTaskCount
      FROM missions m
      ${where}
      ORDER BY m.priority DESC, m.title ASC`,
      (rows) => {
        this._missions = rows
        this.requestUpdate()
      },
    )
  }

  private _missionsForColumn(key: KanbanColumn): MissionRecord[] {
    return this._missions.filter((m) => {
      if (key === "not_started") return m.status === "not_started"
      if (key === "in_progress") return m.status === "in_progress"
      if (key === "completed") return m.status === "completed"
      if (key === "blocked") return m.status === "blocked"
      return false
    })
  }

  override render(): TemplateResult {
    return html`
      <div class="board-scroll">
        ${columnDefs.map(
          (col) => {
            const cards = this._missionsForColumn(col.key)
            return html`
              <div class="column">
                <div class="column-header" style="color:${col.color}">
                  <span>${col.label}</span>
                  <span class="column-count">${cards.length}</span>
                </div>
                <div class="column-body">
                  ${cards.length > 0
                    ? cards.map(
                        (m) => html`<cockpit-mission-card .mission=${m}></cockpit-mission-card>`,
                      )
                    : html`<div class="empty-column">No missions</div>`}
                </div>
              </div>
            `
          },
        )}
      </div>
    `
  }
}

customElements.define("cockpit-mission-board", MissionBoard)

export default MissionBoard
