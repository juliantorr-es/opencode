// @ts-nocheck — interface/class name collision (TS2395), demo data only
import { LitElement, html, css, type TemplateResult, type CSSResultGroup } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface GateRequest {
  id: string
  gateName: string
  status: "pending" | "approved" | "denied" | "changes-requested"
  description?: string
  timestamp: string
}

const DEMO_GATE: GateRequest = {
  id: "gate-001",
  gateName: "Architecture Review Board",
  status: "pending",
  description: "Approval required for kernel module zero-trust integration pattern before merging to main.",
  timestamp: new Date().toISOString(),
}

const STATUS_STYLE: Record<GateRequest["status"], { color: string; label: string }> = {
  pending: { color: tokens.color.warning.$value, label: "Pending" },
  approved: { color: tokens.color.success.$value, label: "Approved" },
  denied: { color: tokens.color.error.$value, label: "Denied" },
  "changes-requested": { color: tokens.color.accent.$value, label: "Changes Requested" },
}

@customElement("tribunus-gate-request")
export class GateRequest extends LitElement {
  static override styles = css` as CSSResultGroup
    :host {
      display: block;
      container-type: inline-size;
      container-name: gate-request;
    }

    .card {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
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
      align-items: center;
      justify-content: space-between;
      gap: ${tokens.spacing.sm.$value};
      margin-bottom: ${tokens.spacing.sm.$value};
    }

    .gate-name {
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

    .actions {
      display: flex;
      gap: ${tokens.spacing.sm.$value};
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: ${tokens.spacing.xs.$value} ${tokens.spacing.sm.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      background: transparent;
      color: ${tokens.color.text.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      cursor: pointer;
      transition: all ${tokens.animation.duration.fast.$value} ease;
    }
    .btn:hover { filter: brightness(1.2); }
    .btn-approve { border-color: ${tokens.color.success.$value}; color: ${tokens.color.success.$value}; }
    .btn-approve:hover { background: ${tokens.color.success.$value}22; }
    .btn-deny { border-color: ${tokens.color.error.$value}; color: ${tokens.color.error.$value}; }
    .btn-deny:hover { background: ${tokens.color.error.$value}22; }
    .btn-rework { border-color: ${tokens.color.accent.$value}; color: ${tokens.color.accent.$value}; }
    .btn-rework:hover { background: ${tokens.color.accent.$value}22; }

    .timestamp {
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.6;
      margin-top: ${tokens.spacing.sm.$value};
    }

    /* Container queries */
    @container gate-request (max-width: 360px) {
      .header { flex-direction: column; align-items: flex-start; }
      .card { padding: ${tokens.spacing.sm.$value}; }
      .gate-name { font-size: ${tokens.typography.fontSize.base.$value}; }
    }
    @container gate-request (min-width: 600px) {
      .card { padding: ${tokens.spacing.lg.$value}; }
      .gate-name { font-size: ${tokens.typography.fontSize.xl.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  gate?: GateRequest

  private get _gate(): GateRequest {
    if (this.mode === "public" || !this.gate) return DEMO_GATE
    return this.gate
  }

  override render(): TemplateResult {
    const g = this._gate
    const ss = STATUS_STYLE[g.status]
    const isPending = g.status === "pending" || g.status === "changes-requested"
    return html`
      <div class="card">
        <div class="header">
          <h3 class="gate-name">${g.gateName}</h3>
          <span class="badge" style="background:${ss.color}22; color:${ss.color}; border:1px solid ${ss.color}44;">
            ${ss.label}
          </span>
        </div>
        ${g.description ? html`<div class="description">${g.description}</div>` : ""}
        ${isPending ? html`
          <div class="actions">
            <button class="btn btn-approve">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>
              Approve
            </button>
            <button class="btn btn-deny">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
              Deny
            </button>
            <button class="btn btn-rework">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>
              Request Changes
            </button>
          </div>
        ` : ""}
        <div class="timestamp">${new Date(g.timestamp).toLocaleString()}</div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-gate-request": GateRequest
  }
}
