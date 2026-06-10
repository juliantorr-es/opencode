import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface ApprovalSheetData {
  id: string
  title: string
  description: string
  status: "pending" | "approved" | "denied" | "changes-requested"
  requestedBy?: string
}

const DEMO_SHEET: ApprovalSheetData = {
  id: "approval-001",
  title: "Release v3.2.0 to Production",
  description: "Approve promotion of build #4821 (commit a3f2c9e) from staging to production. Includes zero-trust IPC upgrade, agent health monitoring, and 14 bug fixes.",
  status: "pending",
  requestedBy: "Orion",
}

const STATUS_STYLE: Record<ApprovalSheetData["status"], { color: string; label: string }> = {
  pending: { color: tokens.color.warning.$value, label: "Pending" },
  approved: { color: tokens.color.success.$value, label: "Approved" },
  denied: { color: tokens.color.error.$value, label: "Denied" },
  "changes-requested": { color: tokens.color.accent.$value, label: "Changes Requested" },
}

@customElement("tribunus-approval-sheet")
export class ApprovalSheet extends LitElement {
  static override styles = css`
    :host {
      display: block;
      container-type: inline-size;
      container-name: approval-sheet;
    }

    .sheet {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      padding: ${tokens.spacing.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
    }

    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: ${tokens.spacing.sm.$value};
      margin-bottom: ${tokens.spacing.sm.$value};
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
      line-height: 1.5;
      margin-bottom: ${tokens.spacing.md.$value};
    }

    .requested-by {
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.55;
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
      gap: 6px;
      padding: ${tokens.spacing.sm.$value} ${tokens.spacing.md.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      background: transparent;
      color: ${tokens.color.text.$value};
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      cursor: pointer;
      transition: all ${tokens.animation.duration.fast.$value} ease;
    }
    .btn:hover { filter: brightness(1.2); }
    .btn-primary { background: ${tokens.color.success.$value}18; border-color: ${tokens.color.success.$value}; color: ${tokens.color.success.$value}; }
    .btn-primary:hover { background: ${tokens.color.success.$value}33; }
    .btn-danger { background: ${tokens.color.error.$value}18; border-color: ${tokens.color.error.$value}; color: ${tokens.color.error.$value}; }
    .btn-danger:hover { background: ${tokens.color.error.$value}33; }
    .btn-secondary { background: ${tokens.color.accent.$value}18; border-color: ${tokens.color.accent.$value}; color: ${tokens.color.accent.$value}; }
    .btn-secondary:hover { background: ${tokens.color.accent.$value}33; }

    /* Container queries */
    @container approval-sheet (max-width: 360px) {
      .header { flex-direction: column; align-items: flex-start; }
      .sheet { padding: ${tokens.spacing.sm.$value}; }
      .title { font-size: ${tokens.typography.fontSize.base.$value}; }
      .actions { flex-direction: column; }
      .btn { justify-content: center; }
    }
    @container approval-sheet (min-width: 600px) {
      .sheet { padding: ${tokens.spacing.lg.$value}; }
      .title { font-size: ${tokens.typography.fontSize.xl.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  sheet?: ApprovalSheetData

  private get _sheet(): ApprovalSheetData {
    if (this.mode === "public" || !this.sheet) return DEMO_SHEET
    return this.sheet
  }

  override render(): TemplateResult {
    const s = this._sheet
    const ss = STATUS_STYLE[s.status]
    const isPending = s.status === "pending" || s.status === "changes-requested"
    return html`
      <div class="sheet">
        <div class="header">
          <h3 class="title">${s.title}</h3>
          <span class="badge" style="background:${ss.color}22; color:${ss.color}; border:1px solid ${ss.color}44;">
            ${ss.label}
          </span>
        </div>
        <div class="description">${s.description}</div>
        ${s.requestedBy ? html`<div class="requested-by">Requested by: ${s.requestedBy}</div>` : ""}
        ${isPending ? html`
          <div class="actions">
            <button class="btn btn-primary">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>
              Accept
            </button>
            <button class="btn btn-danger">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
              Deny
            </button>
            <button class="btn btn-secondary">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>
              Request Changes
            </button>
          </div>
        ` : ""}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-approval-sheet": ApprovalSheet
  }
}
