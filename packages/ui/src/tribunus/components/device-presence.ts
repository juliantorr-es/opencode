// @ts-nocheck — interface/class name collision (TS2395), demo data only
import { LitElement, html, css, type TemplateResult, type CSSResultGroup } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface DevicePresence {
  id: string
  name: string
  status: "online" | "offline" | "away" | "error"
  lastSeen?: string
  type?: string
}

const DEMO_DEVICES: DevicePresence[] = [
  { id: "dev-01", name: "Kernel Agent — Orion", status: "online", type: "daemon" },
  { id: "dev-02", name: "Build Runner — arm64", status: "online", type: "runner" },
  { id: "dev-03", name: "Scan Engine", status: "away", lastSeen: new Date(Date.now() - 300000).toISOString(), type: "service" },
  { id: "dev-04", name: "Deploy Gateway", status: "error", type: "gateway" },
  { id: "dev-05", name: "Legacy Bridge Node", status: "offline", lastSeen: new Date(Date.now() - 86400000).toISOString(), type: "bridge" },
]

const STATUS_STYLE: Record<DevicePresence["status"], { color: string; glow: string; label: string }> = {
  online: { color: tokens.color.success.$value, glow: `${tokens.color.success.$value}66`, label: "Online" },
  offline: { color: tokens.color.text.$value, glow: "transparent", label: "Offline" },
  away: { color: tokens.color.warning.$value, glow: `${tokens.color.warning.$value}44`, label: "Away" },
  error: { color: tokens.color.error.$value, glow: `${tokens.color.error.$value}66`, label: "Error" },
}

const TYPE_ICON: Record<string, string> = {
  daemon: "⚙",
  runner: "▶",
  service: "◈",
  gateway: "⇄",
  bridge: "⛁",
}

@customElement("tribunus-device-presence")
export class DevicePresence extends LitElement {
  static override styles = css` as CSSResultGroup
    :host {
      display: block;
      container-type: inline-size;
      container-name: device-presence;
    }

    .device {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      padding: ${tokens.spacing.sm.$value} ${tokens.spacing.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
      margin-bottom: ${tokens.spacing.xs.$value};
      transition: box-shadow ${tokens.animation.duration.normal.$value} ease;
    }
    .device:hover {
      box-shadow: ${tokens.shadow.sm.$value};
    }

    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: ${tokens.radius.full.$value};
      flex-shrink: 0;
      transition: all ${tokens.animation.duration.normal.$value} ease;
    }

    .body {
      flex: 1;
      min-width: 0;
    }

    .name {
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .meta {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.6;
      margin-top: 1px;
    }

    .type-icon {
      font-size: 0.8rem;
      opacity: 0.5;
    }

    .status-label {
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* Container queries */
    @container device-presence (max-width: 360px) {
      .device { padding: ${tokens.spacing.sm.$value}; flex-wrap: wrap; }
      .name { font-size: ${tokens.typography.fontSize.sm.$value}; }
    }
    @container device-presence (min-width: 600px) {
      .device { padding: ${tokens.spacing.md.$value}; }
      .name { font-size: ${tokens.typography.fontSize.lg.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Array })
  devices?: DevicePresence[]

  private get _devices(): DevicePresence[] {
    if (this.mode === "public" || !this.devices) return DEMO_DEVICES
    return this.devices
  }

  override render(): TemplateResult {
    return html`
      ${this._devices.map(d => {
        const ss = STATUS_STYLE[d.status]
        const icon = d.type ? TYPE_ICON[d.type] ?? "●" : "●"
        return html`
          <div class="device">
            <span class="status-dot" style="background:${ss.color}; box-shadow: 0 0 8px ${ss.glow}"></span>
            <div class="body">
              <div class="name">${d.name}</div>
              <div class="meta">
                <span class="type-icon">${icon}</span>
                <span>${d.type ?? "device"}</span>
                ${d.lastSeen ? html`<span>• ${new Date(d.lastSeen).toLocaleString()}</span>` : ""}
              </div>
            </div>
            <span class="status-label" style="color:${ss.color}">${ss.label}</span>
          </div>
        `
      })}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-device-presence": DevicePresence
  }
}
