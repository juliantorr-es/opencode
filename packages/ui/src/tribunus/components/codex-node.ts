import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface CodexNodeData {
  id: string
  title: string
  category: "architecture" | "protocol" | "pattern" | "decision" | "reference" | "guide"
  lastUpdated: string
  summary?: string
}

const DEMO_NODES: CodexNodeData[] = [
  { id: "cx1", title: "Zero-Trust IPC Channel Design", category: "architecture", lastUpdated: new Date(Date.now() - 3600000).toISOString(), summary: "Design doc for inter-agent IPC with hardware attestation and mTLS." },
  { id: "cx2", title: "Agent Handshake Protocol v2", category: "protocol", lastUpdated: new Date(Date.now() - 7200000).toISOString(), summary: "Mutual authentication flow using ephemeral key exchange." },
  { id: "cx3", title: "State Machine Replication Pattern", category: "pattern", lastUpdated: new Date(Date.now() - 10800000).toISOString(), summary: "Raft-inspired consensus for distributed agent state." },
  { id: "cx4", title: "ADDR-0012: Use Lit for Web Components", category: "decision", lastUpdated: new Date(Date.now() - 14400000).toISOString(), summary: "ADR selecting LitElement as the UI component framework." },
]

const CATEGORY_STYLE: Record<CodexNodeData["category"], { color: string; label: string }> = {
  architecture: { color: tokens.color.primary.$value, label: "Architecture" },
  protocol: { color: tokens.color.accent.$value, label: "Protocol" },
  pattern: { color: tokens.color.success.$value, label: "Pattern" },
  decision: { color: tokens.color.warning.$value, label: "Decision" },
  reference: { color: tokens.color.secondary.$value, label: "Reference" },
  guide: { color: tokens.color.text.$value, label: "Guide" },
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

@customElement("tribunus-codex-node")
export class CodexNode extends LitElement {
  static override styles = css`
    :host {
      display: block;
      container-type: inline-size;
      container-name: codex-node;
    }

    .card {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      padding: ${tokens.spacing.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
      transition: box-shadow ${tokens.animation.duration.normal.$value} ease;
      margin-bottom: ${tokens.spacing.xs.$value};
    }
    .card:hover {
      box-shadow: ${tokens.shadow.md.$value};
    }

    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: ${tokens.spacing.sm.$value};
      margin-bottom: ${tokens.spacing.xs.$value};
    }

    .title {
      font-size: ${tokens.typography.fontSize.base.$value};
      font-weight: ${tokens.typography.fontWeight.semibold.$value};
      margin: 0;
      line-height: 1.3;
    }

    .category-tag {
      display: inline-flex;
      align-items: center;
      padding: 1px ${tokens.spacing.sm.$value};
      border-radius: ${tokens.radius.sm.$value};
      font-size: 0.65rem;
      font-weight: ${tokens.typography.fontWeight.medium.$value};
      white-space: nowrap;
      flex-shrink: 0;
    }

    .summary {
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.7;
      line-height: 1.4;
      margin-bottom: ${tokens.spacing.sm.$value};
    }

    .footer {
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      opacity: 0.55;
    }

    /* Container queries */
    @container codex-node (max-width: 360px) {
      .header { flex-direction: column; }
      .card { padding: ${tokens.spacing.sm.$value}; }
      .title { font-size: ${tokens.typography.fontSize.sm.$value}; }
    }
    @container codex-node (min-width: 600px) {
      .card { padding: ${tokens.spacing.lg.$value}; }
      .title { font-size: ${tokens.typography.fontSize.lg.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Array })
  nodes?: CodexNodeData[]

  private get _nodes(): CodexNodeData[] {
    if (this.mode === "public" || !this.nodes) return DEMO_NODES
    return this.nodes
  }

  override render(): TemplateResult {
    return html`
      ${this._nodes.map(n => {
        const cs = CATEGORY_STYLE[n.category]
        return html`
          <div class="card">
            <div class="header">
              <h4 class="title">${n.title}</h4>
              <span class="category-tag" style="background:${cs.color}22; color:${cs.color}">
                ${cs.label}
              </span>
            </div>
            ${n.summary ? html`<div class="summary">${n.summary}</div>` : ""}
            <div class="footer">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71V3.5Z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16Zm7-8A7 7 0 1 1 1 8a7 7 0 0 1 14 0Z"/></svg>
              Updated ${timeAgo(n.lastUpdated)}
            </div>
          </div>
        `
      })}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-codex-node": CodexNode
  }
}
