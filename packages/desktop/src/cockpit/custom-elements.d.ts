/**
 * Custom element type declarations for SolidJS JSX.
 *
 * Enables use of cockpit Lit Web Components as JSX intrinsic elements
 * in SolidJS templates. Coexists alongside the legacy SolidJS renderer.
 */

import type { JSX as SolidJSX } from "solid-js"

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "cockpit-panel": SolidJSX.HTMLAttributes<HTMLElement> & {
        title?: string
        resizable?: boolean
        collapsed?: boolean
        "resize-direction"?: "horizontal" | "vertical"
      }
      "cockpit-session-dashboard": SolidJSX.HTMLAttributes<HTMLElement> & {
        "status-filter"?: string
        "agent-filter"?: string
      }
      "cockpit-mission-board": SolidJSX.HTMLAttributes<HTMLElement> & {
        "campaign-id"?: string
      }
      "cockpit-gate-monitor": SolidJSX.HTMLAttributes<HTMLElement> & {
        filter?: string
        "max-entries"?: number
      }
      "cockpit-session-card": SolidJSX.HTMLAttributes<HTMLElement>
      "cockpit-mission-card": SolidJSX.HTMLAttributes<HTMLElement>
    }
  }
}

export {}
