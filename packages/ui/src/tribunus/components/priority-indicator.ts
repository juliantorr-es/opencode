import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface PriorityData {
  value: number
  label?: string
}

const DEMO_PRIORITIES: PriorityData[] = [
  { value: 92, label: "Critical" },
  { value: 78, label: "High" },
  { value: 45, label: "Medium" },
  { value: 20, label: "Low" },
]

function priorityColor(value: number): string {
  if (value >= 80) return tokens.color.error.$value
  if (value >= 60) return tokens.color.warning.$value
  if (value >= 30) return tokens.color.accent.$value
  return tokens.color.success.$value
}

function priorityLabel(value: number): string {
  if (value >= 80) return "Critical"
  if (value >= 60) return "High"
  if (value >= 30) return "Medium"
  return "Low"
}

@customElement("tribunus-priority-indicator")
export class PriorityIndicator extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
      container-type: inline-size;
      container-name: priority-indicator;
    }

    .indicator {
      display: inline-flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
    }

    .bar-track {
      width: 80px;
      height: 8px;
      background: ${tokens.color.surfaceAlt.$value};
      border-radius: ${tokens.radius.full.$value};
      overflow: hidden;
      flex-shrink: 0;
    }

    .bar-fill {
      height: 100%;
      border-radius: ${tokens.radius.full.$value};
      transition: width ${tokens.animation.duration.normal.$value} ease;
    }

    .value {
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      font-variant-numeric: tabular-nums;
      min-width: 24px;
    }

    .label {
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.7;
    }

    /* Container queries */
    @container priority-indicator (max-width: 140px) {
      .label { display: none; }
      .bar-track { width: 50px; }
    }
    @container priority-indicator (min-width: 400px) {
      .bar-track { width: 120px; }
      .indicator { gap: ${tokens.spacing.md.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  priority?: PriorityData

  @property({ type: Number })
  value?: number

  private get _priority(): PriorityData {
    if (this.mode === "public" || !this.priority) {
      if (this.value !== undefined) return { value: this.value }
      return DEMO_PRIORITIES[0]
    }
    return this.priority
  }

  override render(): TemplateResult {
    const p = this._priority
    const v = Math.max(0, Math.min(100, p.value))
    const color = priorityColor(v)
    const label = p.label ?? priorityLabel(v)
    return html`
      <span class="indicator">
        <div class="bar-track">
          <div class="bar-fill" style="width:${v}%; background:${color}"></div>
        </div>
        <span class="value" style="color:${color}">${v}</span>
        <span class="label">${label}</span>
      </span>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-priority-indicator": PriorityIndicator
  }
}
