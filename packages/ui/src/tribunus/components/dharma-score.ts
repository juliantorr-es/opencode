// @ts-nocheck — lit css tagged template literal type (TS2345)
import { LitElement, html, css, type TemplateResult, type CSSResultGroup } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface DharmaDimension {
  label: string
  score: number
}

interface DharmaScoreData {
  overall: number
  dimensions: DharmaDimension[]
}

const DEMO_DHARMA: DharmaScoreData = {
  overall: 0.81,
  dimensions: [
    { label: "Wisdom", score: 0.88 },
    { label: "Compassion", score: 0.76 },
    { label: "Discipline", score: 0.92 },
    { label: "Insight", score: 0.71 },
    { label: "Service", score: 0.85 },
    { label: "Truth", score: 0.79 },
  ],
}

const DHARMA_COLORS = [
  tokens.color.primary.$value,
  tokens.color.secondary.$value,
  tokens.color.accent.$value,
  tokens.color.success.$value,
  tokens.color.warning.$value,
  tokens.color.error.$value,
]

@customElement("tribunus-dharma-score")
export class DharmaScore extends LitElement {
  static override styles = css` as CSSResultGroup
    :host {
      display: block;
      container-type: inline-size;
      container-name: dharma-score;
    }

    .card {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.lg.$value};
      padding: ${tokens.spacing.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
    }

    .overall-section {
      text-align: center;
      margin-bottom: ${tokens.spacing.lg.$value};
    }

    .overall-value {
      font-size: ${tokens.typography.fontSize["3xl"].$value};
      font-weight: ${tokens.typography.fontWeight.bold.$value};
      line-height: 1;
    }

    .overall-label {
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.6;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-top: ${tokens.spacing.xs.$value};
    }

    .radar {
      display: flex;
      flex-direction: column;
      gap: ${tokens.spacing.sm.$value};
    }

    .dimension {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .dimension-header {
      display: flex;
      justify-content: space-between;
      font-size: ${tokens.typography.fontSize.sm.$value};
    }

    .dimension-label {
      font-weight: ${tokens.typography.fontWeight.medium.$value};
    }

    .dimension-score {
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
    }

    .dimension-track {
      width: 100%;
      height: 8px;
      background: ${tokens.color.surfaceAlt.$value};
      border-radius: ${tokens.radius.full.$value};
      overflow: hidden;
    }

    .dimension-fill {
      height: 100%;
      border-radius: ${tokens.radius.full.$value};
      transition: width ${tokens.animation.duration.slow.$value} ease;
    }

    /* Container queries */
    @container dharma-score (max-width: 360px) {
      .card { padding: ${tokens.spacing.sm.$value}; }
      .overall-value { font-size: ${tokens.typography.fontSize["2xl"].$value}; }
      .radar { gap: ${tokens.spacing.xs.$value}; }
    }
    @container dharma-score (min-width: 600px) {
      .card { padding: ${tokens.spacing.lg.$value}; }
      .overall-value { font-size: ${tokens.typography.fontSize["3xl"].$value}; }
      .dimension-track { height: 10px; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Object })
  dharma?: DharmaScoreData

  private get _dharma(): DharmaScoreData {
    if (this.mode === "public" || !this.dharma) return DEMO_DHARMA
    return this.dharma
  }

  override render(): TemplateResult {
    const d = this._dharma
    const pct = Math.round(d.overall * 100)
    const overallColor = pct >= 80 ? tokens.color.success.$value : pct >= 60 ? tokens.color.warning.$value : tokens.color.error.$value
    return html`
      <div class="card">
        <div class="overall-section">
          <div class="overall-value" style="color:${overallColor}">${pct}%</div>
          <div class="overall-label">Dharma Score</div>
        </div>
        <div class="radar">
          ${d.dimensions.map((dim, i) => {
            const color = DHARMA_COLORS[i % DHARMA_COLORS.length]
            const dimPct = Math.round(dim.score * 100)
            return html`
              <div class="dimension">
                <div class="dimension-header">
                  <span class="dimension-label">${dim.label}</span>
                  <span class="dimension-score">${dimPct}%</span>
                </div>
                <div class="dimension-track">
                  <div class="dimension-fill" style="width:${dimPct}%; background:${color}"></div>
                </div>
              </div>
            `
          })}
        </div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-dharma-score": DharmaScore
  }
}
