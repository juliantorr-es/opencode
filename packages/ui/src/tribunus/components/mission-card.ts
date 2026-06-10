import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface Mission {
  id: string
  title: string
  description?: string
  status: "active" | "completed" | "blocked" | "pending"
  progress: number
  laneCount: number
  completedLanes: number
}

const DEMO_MISSION: Mission = {
  id: "mission-001",
  title: "Zero-Trust Integration Layer",
  description: "Implement attestation chain for all inter-agent IPC calls",
  status: "active",
  progress: 0.6,
  laneCount: 5,
  completedLanes: 3,
}

const STATUS_STYLE: Record<Mission["status"], { color: string; label: string }> = {
  active: { color: tokens.color.success.$value, label: "Active" },
  completed: { color: tokens.color.primary.$value, label: "Completed" },
  blocked: { color: tokens.color.error.$value, label: "Blocked" },
  pending: { color: tokens.color.warning.$value, label: "Pending" },
}

@customElement("tribunus-mission-card")
export class MissionCard extends LitElement {
  static override styles = css`
    :host {
      display: block;
      container-type: inline-size;
      container-name: mission-card;
    }

    .card {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.lg.$value};
      padding: ${tokens.spacing.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
      transition: box-shadow ${tokens.animation.duration.normal.$value} ease;
    }
    .card:hover {
      box-shadow: ${tokens.shadow.md.$value};
    }

    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: ${tokens.spacing.sm.$value};
      margin-bottom: ${tokens.spacing.xs.$value};
    }

    .title {
      font-size: ${tokens.typography.fontSize.lg.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      margin: 0;
      line-height: 1.3;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px ${tokens.spacing.sm.$value};
      border-radius: ${tokens.radius.full.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      white-space: nowrap;
      flex-shrink: 0;
    }

    .description {
      font-size: ${tokens.typography.fontSize.base.$value};
      opacity: 0.7;
      line-height: 1.4;
      margin-bottom: ${tokens.spacing.md.$value};
    }

    .stats {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.md.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.75;
      margin-bottom: ${tokens.spacing.sm.$value};
    }

    .stat-item {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.xs.$value};
    }

    .progress-track {
      width: 100%;
      height: 6px;
      background: ${tokens.color.surfaceAlt.$value};
      border-radius: ${tokens.radius.full.$value};
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: ${tokens.radius.full.$value};
      transition: width ${tokens.animation.duration.slow.$value} ease;
    }

    .progress-label {
      display: flex;
      justify-content: space-between;
      font-size: 0.7rem;
      opacity: 0.55;
      margin-top: ${tokens.spacing.xs.$value};
    }

    /* Container queries */
    @container mission-card (max-width: 360px) {
      .header { flex-direction: column; }
      .card { padding: ${tokens.spacing.sm.$value}; }
      .title { font-size: ${tokens.typography.fontSize.base.$value}; }
      .stats { flex-wrap: wrap; gap: ${tokens.spacing.sm.$value}; }
    }
    @container mission-card (min-width: 600px) {
      .card { padding: ${tokens.spacing.lg.$value}; }
      .title { font-size: ${tokens.typography.fontSize.xl.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  mission?: Mission

  private get _mission(): Mission {
    if (this.mode === "public" || !this.mission) return DEMO_MISSION
    return this.mission
  }

  override render(): TemplateResult {
    const m = this._mission
    const ss = STATUS_STYLE[m.status]
    const pct = Math.round(m.progress * 100)
    return html`
      <div class="card">
        <div class="header">
          <h3 class="title">${m.title}</h3>
          <span class="badge" style="background:${ss.color}22; color:${ss.color}; border:1px solid ${ss.color}44;">
            ${ss.label}
          </span>
        </div>
        ${m.description ? html`<div class="description">${m.description}</div>` : ""}
        <div class="stats">
          <span class="stat-item">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.5A1.5 1.5 0 0 1 1.5 0h2A1.5 1.5 0 0 1 5 1.5v2A1.5 1.5 0 0 1 3.5 5h-2A1.5 1.5 0 0 1 0 3.5v-2zM1.5 1a.5.5 0 0 0-.5.5v2a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5v-2a.5.5 0 0 0-.5-.5h-2zM0 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8zm1 3v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2H1zm14-1V8a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v2h14zM2 8.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0 4a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 0 1h-6a.5.5 0 0 1-.5-.5z"/></svg>
            ${m.completedLanes}/${m.laneCount} lanes
          </span>
          <span class="stat-item">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M10 1.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5v.5h-1A1.5 1.5 0 0 0 3.5 4v1H.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3v1A1.5 1.5 0 0 0 5 11.5h1v.5a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-.5h1a1.5 1.5 0 0 0 1.5-1.5V9h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3V4A1.5 1.5 0 0 0 11 2.5h-1V1.5zm-1 1h-2v.5h2v-.5zm-5.5 2h10A.5.5 0 0 1 4 5v5.5a.5.5 0 0 1-.5.5h-2A.5.5 0 0 1 1 10.5v-6A.5.5 0 0 1 1.5 4h2z"/></svg>
            ${pct}%
          </span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%; background:${ss.color}"></div>
        </div>
        <div class="progress-label">
          <span>${m.completedLanes} completed</span>
          <span>${m.laneCount - m.completedLanes} remaining</span>
        </div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-mission-card": MissionCard
  }
}
