/**
 * Panel — base cockpit panel with header, toolbar, content slot, resize handle.
 *
 * Extends LitElement with Shadow DOM. Apply design tokens from desktop shell.
 * Two rendering engines coexist: SolidJS legacy + Lit cockpit. This component
 * is the base for all cockpit panels.
 *
 * Uses static `properties` instead of decorators for compat with the project's
 * TypeScript config (experimental decorators).
 */

import { LitElement, html, css, type TemplateResult } from "lit"

export class Panel extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      position: relative;
      background: var(--color-surface, #1a1a2e);
      border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-md, 8px);
      overflow: hidden;
      font-family: var(--font-sans, system-ui, sans-serif);
      font-size: var(--font-size-sm, 13px);
      color: var(--color-text, #e0e0e0);
    }

    :host(.panel-collapsed) .panel-body,
    :host(.panel-collapsed) .panel-toolbar {
      display: none;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
      background: var(--color-surface-raised, rgba(255, 255, 255, 0.04));
      border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
      user-select: none;
      cursor: default;
    }

    .panel-title {
      font-size: var(--font-size-md, 14px);
      font-weight: var(--font-weight-semibold, 600);
      color: var(--color-text, #e0e0e0);
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .panel-header-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
    }

    .panel-header-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      background: transparent;
      color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
      border-radius: var(--radius-sm, 4px);
      cursor: pointer;
      font-size: var(--font-size-xs, 11px);
      transition: background 0.15s, color 0.15s;
    }

    .panel-header-btn:hover {
      background: var(--color-hover, rgba(255, 255, 255, 0.08));
      color: var(--color-text, #e0e0e0);
    }

    .panel-toolbar {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs, 4px);
      padding: var(--spacing-xs, 4px) var(--spacing-md, 16px);
      background: var(--color-surface, #1a1a2e);
      border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.06));
    }

    .panel-body {
      flex: 1;
      overflow: auto;
      padding: var(--spacing-md, 16px);
      min-height: 0;
    }

    ::slotted(*) {
      box-sizing: border-box;
    }

    .panel-resize-handle {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 8px;
      height: 8px;
      cursor: nwse-resize;
      background: transparent;
    }

    .panel-resize-handle::after {
      content: "";
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 4px;
      height: 4px;
      border-right: 1px solid var(--color-text-muted, rgba(255, 255, 255, 0.3));
      border-bottom: 1px solid var(--color-text-muted, rgba(255, 255, 255, 0.3));
    }

    .panel-resize-handle:hover::after {
      border-color: var(--color-accent, #4a9eff);
    }

    .panel-resize-bar {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      cursor: col-resize;
      background: transparent;
      transition: background 0.15s;
    }

    .panel-resize-bar:hover,
    .panel-resize-bar.resizing {
      background: var(--color-accent, #4a9eff);
      opacity: 0.3;
    }

    .panel-resize-bar-bottom {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 4px;
      cursor: row-resize;
      background: transparent;
      transition: background 0.15s;
    }

    .panel-resize-bar-bottom:hover,
    .panel-resize-bar-bottom.resizing {
      background: var(--color-accent, #4a9eff);
      opacity: 0.3;
    }
  `

  static override properties = {
    title: { type: String },
    resizable: { type: Boolean },
    collapsed: { type: Boolean, reflect: true },
    resizeDirection: { type: String },
  }

  title = "Panel"
  resizable = false
  collapsed = false
  resizeDirection: "horizontal" | "vertical" = "horizontal"

  /** Internal flag for active resize operation. */
  private _resizing = false
  private _startX = 0
  private _startY = 0
  private _startWidth = 0
  private _startHeight = 0

  override connectedCallback(): void {
    super.connectedCallback()
    this.addEventListener("pointerdown", this._onPointerDown as EventListener)
    document.addEventListener("pointermove", this._onPointerMove)
    document.addEventListener("pointerup", this._onPointerUp)
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.removeEventListener("pointerdown", this._onPointerDown as EventListener)
    document.removeEventListener("pointermove", this._onPointerMove)
    document.removeEventListener("pointerup", this._onPointerUp)
  }

  private _onPointerDown = (e: PointerEvent): void => {
    if (!this.resizable) return
    const target = e.target as HTMLElement
    const bar = this.shadowRoot?.querySelector(".panel-resize-bar")
    const barB = this.shadowRoot?.querySelector(".panel-resize-bar-bottom")
    const handle = this.shadowRoot?.querySelector(".panel-resize-handle")
    if (
      target !== bar &&
      target !== barB &&
      target !== handle
    ) {
      return
    }
    this._resizing = true
    this._startX = e.clientX
    this._startY = e.clientY
    this._startWidth = this.offsetWidth
    this._startHeight = this.offsetHeight

    if (bar) bar.classList.add("resizing")
    if (barB) barB.classList.add("resizing")

    this.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  private _onPointerMove = (e: PointerEvent): void => {
    if (!this._resizing) return
    const dx = e.clientX - this._startX
    const dy = e.clientY - this._startY

    if (this.resizeDirection === "vertical") {
      this.style.height = `${Math.max(100, this._startHeight + dy)}px`
    } else {
      this.style.width = `${Math.max(200, this._startWidth + dx)}px`
    }
  }

  private _onPointerUp = (): void => {
    if (!this._resizing) return
    this._resizing = false
    const bar = this.shadowRoot?.querySelector(".panel-resize-bar")
    const barB = this.shadowRoot?.querySelector(".panel-resize-bar-bottom")
    if (bar) bar.classList.remove("resizing")
    if (barB) barB.classList.remove("resizing")
    this.dispatchEvent(new CustomEvent("panel-resize-end", { bubbles: true }))
  }

  private _toggleCollapse(): void {
    this.collapsed = !this.collapsed
    this.classList.toggle("panel-collapsed", this.collapsed)
    this.dispatchEvent(new CustomEvent("panel-toggle", {
      detail: { collapsed: this.collapsed },
      bubbles: true,
    }))
  }

  override render(): TemplateResult {
    return html`
      <div class="panel-header">
        <span class="panel-title">${this.title}</span>
        <div class="panel-header-actions">
          <button
            class="panel-header-btn"
            @click=${this._toggleCollapse}
            title=${this.collapsed ? "Expand" : "Collapse"}
            part="collapse-btn"
          >
            ${this.collapsed ? "\u25B6" : "\u25BC"}
          </button>
        </div>
      </div>

      <div class="panel-toolbar" part="toolbar">
        <slot name="toolbar"></slot>
      </div>

      <div class="panel-body" part="body">
        <slot></slot>
      </div>

      ${this.resizable && this.resizeDirection === "horizontal"
        ? html`<div class="panel-resize-bar"></div>`
        : ""}
      ${this.resizable && this.resizeDirection === "vertical"
        ? html`<div class="panel-resize-bar-bottom"></div>`
        : ""}
      ${this.resizable
        ? html`<div class="panel-resize-handle"></div>`
        : ""}
    `
  }
}

customElements.define("cockpit-panel", Panel)

export default Panel
