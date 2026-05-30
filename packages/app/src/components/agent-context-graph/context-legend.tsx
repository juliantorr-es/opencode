const LEGEND_ITEMS = [
  { type: "File", color: "#3b82f6", shape: "circle" as const },
  { type: "Directory", color: "#8b5cf6", shape: "circle" as const },
  { type: "Pattern", color: "#22c55e", shape: "circle" as const },
  { type: "Concept", color: "#f59e0b", shape: "circle" as const },
  { type: "Dependency", color: "#ef4444", shape: "circle" as const },
]

export function ContextLegend() {
  return (
    <div class="context-graph-legend">
      {LEGEND_ITEMS.map((item) => (
        <div class="context-graph-legend-item">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <circle cx="6" cy="6" r="5" fill={item.color} />
          </svg>
          <span class="context-graph-legend-label">{item.type}</span>
        </div>
      ))}
    </div>
  )
}
