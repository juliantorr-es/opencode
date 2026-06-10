import { LitElement, html, css, type TemplateResult } from "lit"
import { customElement, property } from "lit/decorators.js"
import { tokens } from "../tokens.js"

type Mode = "public" | "authenticated"

interface QueueItemData {
  id: string
  position: number
  workType: "build" | "deploy" | "scan" | "review" | "test"
  priority: number
  title: string
  status: "queued" | "running" | "completed" | "failed"
}

const DEMO_ITEMS: QueueItemData[] = [
  { id: "q1", position: 1, workType: "build", priority: 92, title: "Kernel module build — arm64", status: "running" },
  { id: "q2", position: 2, workType: "scan", priority: 78, title: "Dependency vulnerability scan", status: "queued" },
  { id: "q3", position: 3, workType: "deploy", priority: 45, title: "Staging environment sync", status: "queued" },
  { id: "q4", position: 4, workType: "review", priority: 60, title: "Code review — auth module", status: "queued" },
  { id: "q5", position: 5, workType: "test", priority: 88, title: "Integration test suite", status: "queued" },
]

const WORK_TYPE_LABEL: Record<QueueItemData["workType"], string> = {
  build: "Build",
  deploy: "Deploy",
  scan: "Scan",
  review: "Review",
  test: "Test",
}

const WORK_TYPE_COLOR: Record<QueueItemData["workType"], string> = {
  build: tokens.color.primary.$value,
  deploy: tokens.color.success.$value,
  scan: tokens.color.warning.$value,
  review: tokens.color.accent.$value,
  test: tokens.color.secondary.$value,
}

const STATUS_DOT: Record<QueueItemData["status"], string> = {
  queued: tokens.color.text.$value,
  running: tokens.color.accent.$value,
  completed: tokens.color.success.$value,
  failed: tokens.color.error.$value,
}

function priorityColor(p: number): string {
  if (p >= 80) return tokens.color.error.$value
  if (p >= 60) return tokens.color.warning.$value
  if (p >= 30) return tokens.color.accent.$value
  return tokens.color.success.$value
}

@customElement("tribunus-queue-item")
export class QueueItem extends LitElement {
  static override styles = (css as any)`
    :host {
      display: block;
      container-type: inline-size;
      container-name: queue-item;
    }

    .item {
      background: ${tokens.color.surface.$value};
      border: 1px solid ${tokens.color.border.$value};
      border-radius: ${tokens.radius.md.$value};
      padding: ${tokens.spacing.sm.$value} ${tokens.spacing.md.$value};
      font-family: system-ui, sans-serif;
      color: ${tokens.color.text.$value};
      display: flex;
      align-items: center;
      gap: ${tokens.spacing.sm.$value};
      margin-bottom: ${tokens.spacing.xs.$value};
    }

    .position {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      height: 28px;
      border-radius: ${tokens.radius.full.$value};
      background: ${tokens.color.surfaceAlt.$value};
      font-size: ${tokens.typography.fontSize.sm.$value};
      font-weight: ${tokens.typography.fontWeight.bold.$value};
      flex-shrink: 0;
    }

    .body {
      flex: 1;
      min-width: 0;
    }

    .title {
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
      opacity: 0.7;
      margin-top: 2px;
    }

    .work-type {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 ${tokens.spacing.sm.$value};
      border-radius: ${tokens.radius.sm.$value};
      font-size: 0.7rem;
      font-weight: ${tokens.typography.fontWeight.medium.$value};
    }

    .priority-bar {
      width: 60px;
      height: 4px;
      background: ${tokens.color.surfaceAlt.$value};
      border-radius: ${tokens.radius.full.$value};
      overflow: hidden;
      flex-shrink: 0;
    }

    .priority-fill {
      height: 100%;
      border-radius: ${tokens.radius.full.$value};
      transition: width ${tokens.animation.duration.normal.$value} ease;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: ${tokens.radius.full.$value};
      flex-shrink: 0;
    }

    /* Container queries */
    @container queue-item (max-width: 360px) {
      .item { flex-wrap: wrap; padding: ${tokens.spacing.sm.$value}; }
      .position { min-width: 24px; height: 24px; font-size: 0.7rem; }
      .title { font-size: ${tokens.typography.fontSize.sm.$value}; }
      .priority-bar { width: 40px; }
    }
    @container queue-item (min-width: 600px) {
      .item { padding: ${tokens.spacing.md.$value}; }
    }
  `

  @property({ type: String })
  mode: Mode = "public"

  @property({ type: Array })
  items?: QueueItemData[]

  private get _items(): QueueItemData[] {
    if (this.mode === "public" || !this.items) return DEMO_ITEMS
    return this.items
  }

  override render(): TemplateResult {
    return html`
      ${this._items.map(q => {
        const pc = priorityColor(q.priority)
        return html`
          <div class="item">
            <span class="position">${q.position}</span>
            <div class="body">
              <div class="title">${q.title}</div>
              <div class="meta">
                <span class="work-type" style="background:${WORK_TYPE_COLOR[q.workType]}22; color:${WORK_TYPE_COLOR[q.workType]}">
                  ${WORK_TYPE_LABEL[q.workType]}
                </span>
                <div class="priority-bar">
                  <div class="priority-fill" style="width:${q.priority}%; background:${pc}"></div>
                </div>
                <span>P${q.priority}</span>
              </div>
            </div>
            <span class="status-dot" style="background:${STATUS_DOT[q.status]}; box-shadow: ${q.status === "running" ? `0 0 6px ${STATUS_DOT[q.status]}66` : "none"}"></span>
          </div>
        `
      })}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tribunus-queue-item": QueueItem
  }
}
