// @ts-nocheck — lit css tagged template literal type (TS2345)
import { LitElement, html, css, type TemplateResult, type CSSResultGroup } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface Session {
  id: string
  title: string
  status: "active" | "completed" | "archived"
  agentCount: number
  timestamp: string
}

const DEMO_SESSION: Session = {
  id: "demo-001",
  title: "Architecture Review — Kernel Module",
  status: "active",
  agentCount: 4,
  timestamp: new Date().toISOString(),
}

const STATUS_LABEL: Record<Session["status"], string> = {
  active: "Active",
  completed: "Completed",
  archived: "Archived",
}

const STATUS_COLOR: Record<Session["status"], string> = {
  active: tokens.color.success.$value,
  completed: tokens.color.primary.$value,
  archived: tokens.color.warning.$value,
}

@customElement("tribunus-session-card")
export class SessionCard extends LitElement {
  static override styles = css` as CSSResultGroup
    :host {
      display: block;
      container-type: inline-size;
      container-name: session-card;
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
      margin-bottom: ${tokens.spacing.sm.$value};
    }
    .title {
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      margin: 0;
      line-height: 1.4;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: ${tokens.spacing.xs.$value};
      padding: 2px ${tokens.spacing.sm.$value};
      border-radius: ${tokens.radius.full.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      white-space: nowrap;
      flex-shrink: 0;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.md.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.75;
    }
    .meta-item {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.xs.$value};
    }

    /* Container queries */
    @container session-card (max-width: 360px) {
      .card { padding: ${tokens.spacing.sm.$value}; }
      .header { flex-direction: column; }
      .meta { flex-wrap: wrap; gap: ${tokens.spacing.sm.$value}; }
    }
    @container session-card (min-width: 600px) {
      .card { padding: ${tokens.spacing.lg.$value}; }
      .title { font-size: ${tokens.typography.fontSize.lg.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  session?: Session

  private get _session(): Session {
    if (this.mode === "public" || !this.session) return DEMO_SESSION
    return this.session
  }

  override render(): TemplateResult {
    const s = this._session
    return html`
      <div class="card">
        <div class="header">
          <h3 class="title">${s.title}</h3>
          <span
            class="badge"
            style="background:${STATUS_COLOR[s.status]}22; color:${STATUS_COLOR[s.status]}; border:1px solid ${STATUS_COLOR[s.status]}44;"
          >
            ${STATUS_LABEL[s.status]}
          </span>
        </div>
        <div class="meta">
          <span class="meta-item">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7 14s-1 0-1-1 1-4 5-4 5 3 5 4-1 1-1 1H7Zm4-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5.784 6A2.238 2.238 0 0 1 5 13c0-1.355.68-2.75 1.936-3.72A6.325 6.325 0 0 0 5 9c-4 0-5 3-5 4s1 1 1 1h4.216Z"/></svg>
            ${s.agentCount} agent${s.agentCount !== 1 ? "s" : ""}
          </span>
          <span class="meta-item">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5Z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0Z"/></svg>
            ${new Date(s.timestamp).toLocaleString()}
          </span>
        </div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-session-card": SessionCard
  }
}
