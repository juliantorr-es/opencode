import { createEffect, createSignal, For } from "solid-js"
import { useSessionViz } from "@/context/session-viz"
import "./codebase-map.css"

// Static package graph derived from repo structure
interface PackageNode {
  id: string
  label: string
  color: string
  children?: PackageNode[]
}

const PACKAGES: PackageNode[] = [
  { id: "core", label: "@core", color: "#4A90D9" },
  {
    id: "opencode",
    label: "@opencode",
    color: "#E67E22",
    children: [
      { id: "opencode-session", label: "session", color: "#E67E22" },
      { id: "opencode-tool", label: "tool", color: "#D35400" },
      { id: "opencode-server", label: "server", color: "#F39C12" },
      { id: "opencode-storage", label: "storage", color: "#E67E22" },
    ],
  },
  {
    id: "app",
    label: "@app",
    color: "#2ECC71",
    children: [
      { id: "app-components", label: "components", color: "#27AE60" },
      { id: "app-pages", label: "pages", color: "#2ECC71" },
      { id: "app-context", label: "context", color: "#1ABC9C" },
    ],
  },
  {
    id: "desktop",
    label: "@desktop",
    color: "#9B59B6",
    children: [
      { id: "desktop-main", label: "main", color: "#8E44AD" },
      { id: "desktop-renderer", label: "renderer", color: "#9B59B6" },
      { id: "desktop-preload", label: "preload", color: "#7D3C98" },
    ],
  },
  {
    id: "ui",
    label: "@ui",
    color: "#E74C3C",
    children: [
      { id: "ui-components", label: "components", color: "#C0392B" },
      { id: "ui-v2", label: "v2", color: "#E74C3C" },
    ],
  },
  { id: "llm", label: "@llm", color: "#1ABC9C" },
  { id: "plugin", label: "@plugin", color: "#F39C12" },
  { id: "sdk", label: "@sdk", color: "#3498DB" },
  { id: "enterprise", label: "@enterprise", color: "#E91E63" },
  { id: "console", label: "@console", color: "#00BCD4" },
]

export function CodebaseMap() {
  const { claimedPaths, isConnected } = useSessionViz()
  const [activePackages, setActivePackages] = createSignal<Set<string>>(new Set())

  // Track which packages have active sessions working in them
  createEffect(() => {
    const claimed = claimedPaths()
    const active = new Set<string>()
    for (const claim of claimed) {
      const parts = claim.path.split("/")
      if (parts.length > 1) {
        // e.g., packages/core/... → core
        const pkgIndex = parts.indexOf("packages")
        if (pkgIndex >= 0 && parts[pkgIndex + 1]) {
          active.add(parts[pkgIndex + 1])
        }
      }
    }
    setActivePackages(active)
  })

  if (!isConnected()) {
    return (
      <div class="flex items-center justify-center h-full text-xs text-text-muted">
        Connecting to session stream...
      </div>
    )
  }

  return (
    <svg viewBox="0 0 400 300" class="w-full h-full">
      <For each={PACKAGES}>
        {(pkg, index) => {
          const isActive = activePackages().has(pkg.id)
          const boxX = 20 + (index() % 3) * 130
          const boxY = 20 + Math.floor(index() / 3) * 60
          const boxW = 115
          const boxH = 36

          return (
            <g>
              {/* Package box */}
              <rect
                x={boxX}
                y={boxY}
                width={boxW}
                height={boxH}
                rx="6"
                fill={`${pkg.color}15`}
                stroke={isActive ? pkg.color : `${pkg.color}40`}
                stroke-width={isActive ? "2" : "1"}
                class={isActive ? "animate-pulse-scale" : ""}
              />

              {/* Package label */}
              <text
                x={boxX + boxW / 2}
                y={boxY + boxH / 2 + 1}
                text-anchor="middle"
                dominant-baseline="central"
                fill={isActive ? pkg.color : `${pkg.color}cc`}
                font-size="11"
                font-weight={isActive ? "600" : "400"}
                font-family="system-ui, sans-serif"
              >
                {pkg.label}
              </text>

              {/* Active indicator dot */}
              {isActive && (
                <circle
                  cx={boxX + boxW - 8}
                  cy={boxY + 8}
                  r="3"
                  fill={pkg.color}
                  class="animate-pulse"
                />
              )}
            </g>
          )
        }}
      </For>
    </svg>
  )
}
