import { createMemo, createSignal, onCleanup } from "solid-js"
import { useAgentContext } from "@/context/agent-context"

const VIEW_BOX_W = 800
const VIEW_BOX_H = 500
const NODE_RADIUS = 18

const TYPE_COLORS: Record<string, string> = {
  file: "#3b82f6",
  directory: "#8b5cf6",
  pattern: "#22c55e",
  concept: "#f59e0b",
  dependency: "#ef4444",
}

interface Position {
  x: number
  y: number
}

function initializePositions(ids: string[]): Record<string, Position> {
  const cx = VIEW_BOX_W / 2
  const cy = VIEW_BOX_H / 2
  const radius = Math.min(VIEW_BOX_W, VIEW_BOX_H) * 0.28
  const positions: Record<string, Position> = {}

  for (let i = 0; i < ids.length; i++) {
    const angle = (2 * Math.PI * i) / ids.length - Math.PI / 2
    positions[ids[i]] = {
      x: cx + radius * Math.cos(angle) + (Math.random() - 0.5) * 40,
      y: cy + radius * Math.sin(angle) + (Math.random() - 0.5) * 40,
    }
  }

  return positions
}

function computeForceLayout(
  ids: string[],
  edges: { source: string; target: string; strength: number }[],
  initial: Record<string, Position>,
  iterations: number,
): Record<string, Position> {
  type SimNode = { x: number; y: number; vx: number; vy: number }
  const sim: Record<string, SimNode> = {}

  for (const id of ids) {
    const p = initial[id]
    sim[id] = { x: p.x, y: p.y, vx: 0, vy: 0 }
  }

  const centerX = VIEW_BOX_W / 2
  const centerY = VIEW_BOX_H / 2

  for (let iter = 0; iter < iterations; iter++) {
    const repForce = 8000
    const centeringStrength = 0.015
    const damping = 0.85 - (iter / iterations) * 0.12

    const forces: Record<string, { fx: number; fy: number }> = {}
    for (const id of ids) {
      forces[id] = { fx: 0, fy: 0 }
    }

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]
        const b = ids[j]
        const dx = sim[a].x - sim[b].x
        const dy = sim[a].y - sim[b].y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const f = repForce / (dist * dist)
        const fx = (dx / dist) * f
        const fy = (dy / dist) * f
        forces[a].fx += fx
        forces[a].fy += fy
        forces[b].fx -= fx
        forces[b].fy -= fy
      }
    }

    for (const edge of edges) {
      const src = sim[edge.source]
      const tgt = sim[edge.target]
      if (!src || !tgt) continue
      const dx = tgt.x - src.x
      const dy = tgt.y - src.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const idealDist = 130
      const f = (dist - idealDist) * 0.004 * edge.strength
      const fx = (dx / dist) * f
      const fy = (dy / dist) * f
      forces[edge.source].fx += fx
      forces[edge.source].fy += fy
      forces[edge.target].fx -= fx
      forces[edge.target].fy -= fy
    }

    for (const id of ids) {
      const dx = centerX - sim[id].x
      const dy = centerY - sim[id].y
      forces[id].fx += dx * centeringStrength
      forces[id].fy += dy * centeringStrength
    }

    for (const id of ids) {
      sim[id].vx = (sim[id].vx + forces[id].fx) * damping
      sim[id].vy = (sim[id].vy + forces[id].fy) * damping
      sim[id].x += sim[id].vx
      sim[id].y += sim[id].vy

      const margin = 60
      sim[id].x = Math.max(margin, Math.min(VIEW_BOX_W - margin, sim[id].x))
      sim[id].y = Math.max(margin, Math.min(VIEW_BOX_H - margin, sim[id].y))
    }
  }

  const result: Record<string, Position> = {}
  for (const id of ids) {
    result[id] = { x: sim[id].x, y: sim[id].y }
  }
  return result
}

export function ContextGraph() {
  const { context, focusNode, clearFocus } = useAgentContext()

  const [positions, setPositions] = createSignal<Record<string, Position>>({})
  const [scale, setScale] = createSignal(1)
  const [panX, setPanX] = createSignal(0)
  const [panY, setPanY] = createSignal(0)
  const [hoveredId, setHoveredId] = createSignal<string | null>(null)
  const [isDragging, setIsDragging] = createSignal(false)
  const [dragStart, setDragStart] = createSignal({ x: 0, y: 0 })
  const [layoutReady, setLayoutReady] = createSignal(false)

  const nodes = createMemo(() => context.nodes)
  const edges = createMemo(() => context.edges)
  const focusNodeId = createMemo(() => context.focusNodeId)
  const nodeIds = createMemo(() => nodes().map((n) => n.id))

  // Connected node IDs for hover/focus dimming
  const connectedIds = createMemo(() => {
    const hovered = hoveredId()
    const focused = focusNodeId()
    const targetId = hovered ?? focused
    if (!targetId) return null

    const ids = new Set<string>()
    ids.add(targetId)

    for (const edge of edges()) {
      if (edge.source === targetId) ids.add(edge.target)
      if (edge.target === targetId) ids.add(edge.source)
    }

    return ids
  })

  // Run force layout on mount or when node ids change
  const ids = nodeIds()
  if (ids.length > 0 && !layoutReady()) {
    const initial = initializePositions(ids)
    const computed = computeForceLayout(ids, edges(), initial, 120)
    setPositions(computed)
    setLayoutReady(true)
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.92 : 1.08
    setScale((s) => Math.max(0.25, Math.min(4, s * delta)))
  }

  function handlePointerDown(e: MouseEvent) {
    if ((e.target as Element).tagName === "svg") {
      setIsDragging(true)
      setDragStart({ x: e.clientX - panX(), y: e.clientY - panY() })
    }
  }

  function handlePointerMove(e: MouseEvent) {
    if (isDragging()) {
      setPanX(e.clientX - dragStart().x)
      setPanY(e.clientY - dragStart().y)
    }
  }

  function handlePointerUp() {
    setIsDragging(false)
  }

  function handleNodeClick(id: string) {
    if (focusNodeId() === id) {
      clearFocus()
    } else {
      focusNode(id)
    }
  }

  function handleNodePointerEnter(id: string) {
    setHoveredId(id)
  }

  function handleNodePointerLeave() {
    setHoveredId(null)
  }

  // Clean up drag state on unmount
  onCleanup(() => {
    setIsDragging(false)
  })

  function nodeOpacity(id: string): number {
    const connected = connectedIds()
    if (connected) {
      return connected.has(id) ? 1 : 0.2
    }
    return 1
  }

  function edgeOpacity(source: string, target: string): number {
    const connected = connectedIds()
    if (connected) {
      return connected.has(source) && connected.has(target) ? 1 : 0.15
    }
    return 0.6
  }

  function nodeColor(type: string): string {
    return TYPE_COLORS[type] ?? "#6b7280"
  }

  const positionedNodes = createMemo(() => {
    const p = positions()
    return nodes().filter((n) => p[n.id])
  })

  const positionedEdges = createMemo(() => {
    const p = positions()
    return edges().filter((e) => p[e.source] && p[e.target])
  })

  return (
    <svg
      viewBox={`0 0 ${VIEW_BOX_W} ${VIEW_BOX_H}`}
      class="context-graph-svg"
      onWheel={handleWheel}
      onMouseDown={handlePointerDown}
      onMouseMove={handlePointerMove}
      onMouseUp={handlePointerUp}
      onMouseLeave={handlePointerUp}
      style={{ cursor: isDragging() ? "grabbing" : "grab" }}
    >
      <g transform={`translate(${panX()}, ${panY()}) scale(${scale()})`}>
        {positionedEdges().map((edge) => {
          const p = positions()
          const src = p[edge.source]
          const tgt = p[edge.target]
          return (
            <line
              x1={src.x}
              y1={src.y}
              x2={tgt.x}
              y2={tgt.y}
              stroke="var(--border-base, #666)"
              stroke-width={Math.max(1, edge.strength * 2.5)}
              opacity={edgeOpacity(edge.source, edge.target)}
              class="context-graph-edge"
            />
          )
        })}
        {positionedNodes().map((node) => {
          const p = positions()[node.id]
          const isFocused = focusNodeId() === node.id
          const color = nodeColor(node.type)
          const opacity = nodeOpacity(node.id)

          return (
            <g
              transform={`translate(${p.x}, ${p.y})`}
              onClick={() => handleNodeClick(node.id)}
              onMouseEnter={() => handleNodePointerEnter(node.id)}
              onMouseLeave={handleNodePointerLeave}
              class="context-graph-node-group"
              style={{ cursor: "pointer" }}
            >
              {isFocused && (
                <circle
                  r={NODE_RADIUS + 5}
                  fill="none"
                  stroke={color}
                  stroke-width={2}
                  class="context-graph-pulse-ring"
                />
              )}
              <circle
                r={NODE_RADIUS}
                fill={color}
                opacity={opacity}
                class="context-graph-node"
              />
              <text
                y={NODE_RADIUS + 14}
                text-anchor="middle"
                fill="var(--text-base, #cdd6f4)"
                font-size="11"
                opacity={opacity}
                class="context-graph-label"
              >
                {node.label}
              </text>
            </g>
          )
        })}
      </g>
    </svg>
  )
}
