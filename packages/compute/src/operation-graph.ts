import type { TensorView } from "./tensor-view.js"

export interface ComputeOp {
  readonly opId: string
  readonly opType: string
  readonly inputs: TensorView[]
  readonly outputs: TensorView[]
  readonly attributes: Record<string, unknown>
  readonly dependencies: string[]
}

export interface OperationGraph {
  readonly ops: readonly ComputeOp[]
  addOp(op: Omit<ComputeOp, "opId">): string
  topologicalOrder(): string[]
  validate(): boolean
}

let nextId = 0

function hasCycle(ops: Map<string, ComputeOp>): boolean {
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(opId: string): boolean {
    if (inStack.has(opId)) return true
    if (visited.has(opId)) return false

    visited.add(opId)
    inStack.add(opId)

    const op = ops.get(opId)
    if (op) {
      for (const dep of op.dependencies) {
        if (ops.has(dep) && dfs(dep)) return true
      }
    }

    inStack.delete(opId)
    return false
  }

  for (const opId of ops.keys()) {
    if (dfs(opId)) return true
  }

  return false
}

function kahnTopologicalSort(ops: Map<string, ComputeOp>): string[] {
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const [opId, op] of ops) {
    if (!inDegree.has(opId)) inDegree.set(opId, 0)
    for (const dep of op.dependencies) {
      if (!ops.has(dep)) continue
      if (!adjacency.has(dep)) adjacency.set(dep, [])
      adjacency.get(dep)!.push(opId)
      inDegree.set(opId, (inDegree.get(opId) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [opId, deg] of inDegree) {
    if (deg === 0) queue.push(opId)
  }

  const order: string[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    order.push(node)
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDeg = inDegree.get(neighbor)! - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    }
  }

  return order
}

export function createOperationGraph(): OperationGraph {
  const ops = new Map<string, ComputeOp>()
  let dirty = true
  let cachedOrder: string[] | null = null

  return {
    get ops(): readonly ComputeOp[] {
      return [...ops.values()]
    },

    addOp(op: Omit<ComputeOp, "opId">): string {
      const opId = `op_${nextId++}`
      ops.set(opId, { ...op, opId })
      dirty = true
      cachedOrder = null
      return opId
    },

    topologicalOrder(): string[] {
      if (!dirty && cachedOrder) return cachedOrder
      const order = kahnTopologicalSort(ops)
      cachedOrder = order
      dirty = false
      return order
    },

    validate(): boolean {
      if (ops.size === 0) return false

      for (const op of ops.values()) {
        for (const dep of op.dependencies) {
          if (!ops.has(dep)) return false
        }
      }

      if (hasCycle(ops)) return false

      const order = this.topologicalOrder()
      const position = new Map<string, number>()
      for (let i = 0; i < order.length; i++) {
        position.set(order[i], i)
      }

      for (const op of ops.values()) {
        for (const dep of op.dependencies) {
          const depPos = position.get(dep)
          const opPos = position.get(op.opId)
          if (depPos === undefined || opPos === undefined) return false
          if (depPos > opPos) return false
        }
      }

      return order.length === ops.size
    },
  }
}
