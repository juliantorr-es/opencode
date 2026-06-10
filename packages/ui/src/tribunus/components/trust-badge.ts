// @ts-nocheck — lit css tagged template literal type (TS2345)
import { LitElement, html, css, type TemplateResult, type CSSResultGroup } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface TrustData {
  score: number
  lane: "low" | "high"
  label?: string
}

const DEMO_TRUST: TrustData = {
  score: 0.87,
  lane: "high",
  label: "Trusted",
}

const LANE_STYLE: Record<TrustData["lane"], { color: string; bg: string; label: string }> = {
  low: { color: tokens.color.error.$value, bg: tokens.color.error.$value, label: "Low Trust" },
  high: { color: tokens.color.success.$value, bg: tokens.color.success.$value, label: "High Trust" },
}

function scorePercent(score: number): string {
  return `${Math.round(score * 100)}%`
}

@customElement("tribunus-trust-badge")
export class TrustBadge extends LitElement {
  static override styles = css` as CSSResultGroup
    :host {
      display: inline-block;
      container-type: inline-size;
      container-name: trust-badge;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      padding: ${tokens.spacing.xs.$value} ${tokens.spacing.sm.$value};
      border-radius: ${tokens.radius.full.$value};
      font-family: system-ui, sans-serif;
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      border: 1px solid;
      transition: all ${tokens.animation.duration.normal.$value} ease;
      cursor: default;
      user-select: none;
    }

    .indicator {
      width: 10px;
      height: 10px;
      border-radius: ${tokens.radius.full.$value};
      flex-shrink: 0;
    }

    .score {
      opacity: 0.8;
      font-weight: ${tokens.typography.fontWeight.medium.$value};
    }

    .label {
      white-space: nowrap;
    }

    /* Container query */
    @container trust-badge (max-width: 140px) {
      .score { display: none; }
      .badge { gap: ${tokens.spacing.xs.$value}; padding: 2px ${tokens.spacing.sm.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  trust?: TrustData

  private get _trust(): TrustData {
    if (this.mode === "public" || !this.trust) return DEMO_TRUST
    return this.trust
  }

  override render(): TemplateResult {
    const t = this._trust
    const ls = LANE_STYLE[t.lane]
    return html`
      <span class="badge" style="background:${ls.color}18; color:${ls.color}; border-color:${ls.color}44;">
        <span class="indicator" style="background:${ls.bg}; box-shadow: 0 0 6px ${ls.bg}66;"></span>
        <span class="label">${t.label ?? ls.label}</span>
        <span class="score">${scorePercent(t.score)}</span>
      </span>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-trust-badge": TrustBadge
  }
}
