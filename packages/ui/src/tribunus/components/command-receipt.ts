// @ts-nocheck — lit css tagged template literal type (TS2345)
import { LitElement, html, css, type TemplateResult, type CSSResultGroup } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface Receipt {
  id: string
  command: string
  outcome: "success" | "failure" | "pending"
  detail: string
  timestamp: string
}

const DEMO_RECEIPT: Receipt = {
  id: "receipt-001",
  command: "deploy:kernel --env=staging",
  outcome: "success",
  detail: "Deployed revision 7a3f2b to staging. Health check passed in 2.3s.",
  timestamp: new Date().toISOString(),
}

const OUTCOME_STYLE: Record<Receipt["outcome"], { color: string; label: string }> = {
  success: { color: tokens.color.success.$value, label: "Success" },
  failure: { color: tokens.color.error.$value, label: "Failure" },
  pending: { color: tokens.color.warning.$value, label: "Pending" },
}

@customElement("tribunus-command-receipt")
export class CommandReceipt extends LitElement {
  static override styles = css` as CSSResultGroup
    :host {
      display: block;
      container-type: inline-size;
      container-name: command-receipt;
    }

    .receipt {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      padding: ${tokens.spacing.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: ${tokens.spacing.sm.$value};
      margin-bottom: ${tokens.spacing.sm.$value};
    }

    .command {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    }

    .outcome-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px ${tokens.spacing.sm.$value};
      border-radius: ${tokens.radius.full.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      white-space: nowrap;
      flex-shrink: 0;
    }

    .outcome-dot {
      width: 8px;
      height: 8px;
      border-radius: ${tokens.radius.full.$value};
    }

    .detail {
      font-size: ${tokens.typography.fontSize.base.$value};
      line-height: 1.5;
      opacity: 0.85;
      margin-bottom: ${tokens.spacing.sm.$value};
    }

    .timestamp {
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.6;
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.xs.$value};
    }

    /* Container queries */
    @container command-receipt (max-width: 360px) {
      .header { flex-direction: column; align-items: flex-start; }
      .receipt { padding: ${tokens.spacing.sm.$value}; }
      .command { font-size: ${tokens.typography.fontSize.sm.$value}; }
    }
    @container command-receipt (min-width: 600px) {
      .receipt { padding: ${tokens.spacing.lg.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  receipt?: Receipt

  private get _receipt(): Receipt {
    if (this.mode === "public" || !this.receipt) return DEMO_RECEIPT
    return this.receipt
  }

  override render(): TemplateResult {
    const r = this._receipt
    const oc = OUTCOME_STYLE[r.outcome]
    return html`
      <div class="receipt">
        <div class="header">
          <span class="command">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H4zm0 1h8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/><path d="M4 6.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm0 3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm0 3a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z"/></svg>
            ${r.command}
          </span>
          <span class="outcome-badge" style="background:${oc.color}22; color:${oc.color}; border:1px solid ${oc.color}44;">
            <span class="outcome-dot" style="background:${oc.color}"></span>
            ${oc.label}
          </span>
        </div>
        <div class="detail">${r.detail}</div>
        <div class="timestamp">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5Z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0Z"/></svg>
          ${new Date(r.timestamp).toLocaleString()}
        </div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-command-receipt": CommandReceipt
  }
}
