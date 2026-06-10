// @ts-nocheck — lit css tagged template literal type (TS2345)
import { LitElement, html, css, type TemplateResult, type CSSResultGroup } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface Agent {
  id: string
  name: string
  avatar?: string
  status: "idle" | "busy" | "error" | "success"
}

const DEMO_AGENTS: Agent[] = [
  { id: "a1", name: "Orion", status: "busy" },
  { id: "a2", name: "Nova", status: "idle" },
  { id: "a3", name: "Sol", status: "success" },
  { id: "a4", name: "Luna", status: "busy" },
  { id: "a5", name: "Atlas", status: "error" },
  { id: "a6", name: "Vega", status: "idle" },
  { id: "a7", name: "Pulsar", status: "success" },
]

const STATUS_DOT: Record<Agent["status"], string> = {
  idle: tokens.color.text.$value,
  busy: tokens.color.accent.$value,
  error: tokens.color.error.$value,
  success: tokens.color.success.$value,
}

@customElement("tribunus-agent-rail")
export class AgentRail extends LitElement {
  static override styles = css` as CSSResultGroup
    :host {
      display: block;
      container-type: inline-size;
      container-name: agent-rail;
    }

    .rail {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      padding: ${tokens.spacing.sm.$value} 0;
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: ${tokens.color.border.$value} transparent;
      -webkit-overflow-scrolling: touch;
    }

    .agent {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${tokens.spacing.xs.$value};
      cursor: pointer;
      transition: opacity ${tokens.animation.duration.fast.$value} ease;
      flex-shrink: 0;
    }
    .agent:hover {
      opacity: 0.8;
    }

    .avatar {
      position: relative;
      width: 40px;
      height: 40px;
      border-radius: ${tokens.radius.full.$value};
      background: ${tokens.color.surfaceAlt.$value};
      border: 2px solid ${tokens.color.border.$value};
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      color: ${tokens.color.primary.$value};
    }

    .status-dot {
      position: absolute;
      bottom: -2px;
      right: -2px;
      width: 12px;
      height: 12px;
      border-radius: ${tokens.radius.full.$value};
      border: 2px solid ${tokens.color.surface.$value};
    }

    .name {
      font-size: ${tokens.typography.fontSize.sm.$value};
      color: ${tokens.color.text.$value};
      max-width: 56px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: center;
    }

    /* Container queries */
    @container agent-rail (max-width: 360px) {
      .avatar { width: 32px; height: 32px; font-size: ${tokens.typography.fontSize.sm.$value}; }
      .name { max-width: 44px; font-size: 0.65rem; }
      .status-dot { width: 10px; height: 10px; }
    }
    @container agent-rail (min-width: 600px) {
      .avatar { width: 48px; height: 48px; }
      .rail { gap: ${tokens.spacing.md.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Array })
  agents?: Agent[]

  private get _agents(): Agent[] {
    if (this.mode === "public" || !this.agents) return DEMO_AGENTS
    return this.agents
  }

  override render(): TemplateResult {
    return html`
      <div class="rail">
        ${this._agents.map(
          (a) => html`
            <div class="agent" title="${a.name}">
              <div class="avatar">
                ${a.name.charAt(0).toUpperCase()}
                <span class="status-dot" style="background:${STATUS_DOT[a.status]}"></span>
              </div>
              <span class="name">${a.name}</span>
            </div>
          `,
        )}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-agent-rail": AgentRail
  }
}
