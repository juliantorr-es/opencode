import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

type StatusValue = string

interface StatusBadgeData {
  value: StatusValue
  label?: string
  color?: string
}

const DEFAULT_COLORS: Record<string, string> = {
  active: tokens.color.success.$value,
  completed: tokens.color.primary.$value,
  pending: tokens.color.warning.$value,
  blocked: tokens.color.error.$value,
  success: tokens.color.success.$value,
  failure: tokens.color.error.$value,
  failed: tokens.color.error.$value,
  error: tokens.color.error.$value,
  info: tokens.color.accent.$value,
  warning: tokens.color.warning.$value,
  critical: tokens.color.error.$value,
  online: tokens.color.success.$value,
  offline: tokens.color.text.$value,
  away: tokens.color.warning.$value,
  archived: tokens.color.secondary.$value,
  approved: tokens.color.success.$value,
  denied: tokens.color.error.$value,
  "changes-requested": tokens.color.accent.$value,
  queued: tokens.color.text.$value,
  running: tokens.color.accent.$value,
  idle: tokens.color.text.$value,
  busy: tokens.color.accent.$value,
  degraded: tokens.color.warning.$value,
  down: tokens.color.error.$value,
  low: tokens.color.error.$value,
  high: tokens.color.success.$value,
}

const STATUS_ICONS: Record<string, string> = {
  active: "●",
  completed: "✓",
  pending: "○",
  blocked: "⊘",
  success: "✓",
  failure: "✗",
  error: "✗",
  info: "i",
  warning: "!",
  critical: "⚠",
  online: "●",
  offline: "○",
  away: "◐",
  approved: "✓",
  denied: "✗",
  "changes-requested": "↻",
  running: "▶",
  idle: "—",
  busy: "●",
  degraded: "◑",
  down: "✗",
  low: "↓",
  high: "↑",
}

function resolveColor(value: string): string {
  return DEFAULT_COLORS[value] ?? tokens.color.text.$value
}

function resolveLabel(value: string): string {
  return DEFAULT_COLORS[value] ? value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ") : value
}

@customElement("tribunus-status-badge")
export class StatusBadge extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
      container-type: inline-size;
      container-name: status-badge;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px ${tokens.spacing.sm.$value};
      border-radius: ${tokens.radius.full.$value};
      font-family: system-ui, sans-serif;
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      white-space: nowrap;
      user-select: none;
    }

    .icon {
      font-size: 0.65rem;
      line-height: 1;
    }

    /* Container queries */
    @container status-badge (max-width: 80px) {
      .label { display: none; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  badge?: StatusBadgeData

  @property({ type: String })
  value?: string

  private get _badge(): StatusBadgeData {
    if (this.mode === "public" || !this.badge) {
      return this.badge ?? { value: this.value ?? "active" }
    }
    return this.badge
  }

  override render(): TemplateResult {
    const b = this._badge
    const color = b.color ?? resolveColor(b.value)
    const label = b.label ?? resolveLabel(b.value)
    const icon = STATUS_ICONS[b.value] ?? ""
    return html`
      <span class="badge" style="background:${color}22; color:${color}; border:1px solid ${color}44;">
        ${icon ? html`<span class="icon">${icon}</span>` : ""}
        <span class="label">${label}</span>
      </span>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-status-badge": StatusBadge
  }
}
