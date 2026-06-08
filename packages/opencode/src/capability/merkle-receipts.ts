import { createHash } from "node:crypto"

export interface ReceiptLeaf {
  receiptId: string; timestamp: number; contentHash: string; predecessorId: string | null
}
export interface MerkleNode { hash: string; left?: MerkleNode; right?: MerkleNode }
export interface MerkleProof {
  receiptId: string; leafHash: string; proofPath: string[]; rootHash: string; leafIndex: number; totalLeaves: number
}
export interface SessionMerkleRoot {
  sessionId: string; rootHash: string; leafCount: number; previousRootHash: string | null; anchoredAt?: number
}

function sha256(data: string): string { return createHash("sha256").update(data).digest("hex") }
function hashPair(left: string, right: string): string { return sha256(left + right) }
function receiptHash(r: ReceiptLeaf): string { return sha256(`${r.receiptId}:${r.timestamp}:${r.contentHash}:${r.predecessorId ?? "genesis"}`) }

export function buildMerkleTree(leaves: ReceiptLeaf[]): MerkleNode {
  if (leaves.length === 0) return { hash: sha256("empty_tree") }
  let nodes: MerkleNode[] = leaves.map((l) => ({ hash: receiptHash(l) }))
  while (nodes.length > 1) {
    const next: MerkleNode[] = []
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i]; const right = nodes[i + 1] ?? { hash: sha256("null") }
      next.push({ hash: hashPair(left.hash, right.hash), left, right })
    }
    nodes = next
  }
  return nodes[0]
}

export function computeMerkleRoot(leaves: ReceiptLeaf[]): string { return buildMerkleTree(leaves).hash }

export function generateMerkleProof(leaves: ReceiptLeaf[], receiptId: string): MerkleProof | null {
  const leafIndex = leaves.findIndex((l) => l.receiptId === receiptId)
  if (leafIndex === -1) return null
  const leafHash = receiptHash(leaves[leafIndex])
  const proofPath: string[] = []
  let levelHashes = leaves.map((l) => receiptHash(l))
  let index = leafIndex
  while (levelHashes.length > 1) {
    const isLeft = index % 2 === 0
    const siblingIndex = isLeft ? index + 1 : index - 1
    if (siblingIndex >= 0 && siblingIndex < levelHashes.length) {
      proofPath.push(levelHashes[siblingIndex])
    } else {
      proofPath.push(sha256("null"))
    }
    const nextLevel: string[] = []
    for (let i = 0; i < levelHashes.length; i += 2) {
      nextLevel.push(hashPair(levelHashes[i], levelHashes[i + 1] ?? sha256("null")))
    }
    levelHashes = nextLevel
    index = Math.floor(index / 2)
  }
  return { receiptId, leafHash, proofPath, rootHash: levelHashes[0], leafIndex, totalLeaves: leaves.length }
}

export function verifyMerkleProof(proof: MerkleProof, trustedRootHash: string): boolean {
  if (proof.rootHash !== trustedRootHash) return false
  let hash = proof.leafHash; let idx = proof.leafIndex
  for (const sibling of proof.proofPath) {
    hash = idx % 2 === 0 ? hashPair(hash, sibling) : hashPair(sibling, hash)
    idx = Math.floor(idx / 2)
  }
  return hash === trustedRootHash
}

export function buildCrossSessionChain(roots: SessionMerkleRoot[]): SessionMerkleRoot[] {
  const s = [...roots].sort((a, b) => (a.anchoredAt ?? 0) - (b.anchoredAt ?? 0) || a.sessionId.localeCompare(b.sessionId))
  for (let i = 1; i < s.length; i++) s[i] = { ...s[i], previousRootHash: s[i - 1].rootHash }
  return s
}

export function verifyCrossSessionChain(roots: SessionMerkleRoot[]): boolean {
  for (let i = 1; i < roots.length; i++) if (roots[i].previousRootHash !== roots[i - 1].rootHash) return false
  return true
}

export function anchorSessionRoot(root: SessionMerkleRoot, prev: SessionMerkleRoot | null): SessionMerkleRoot {
  return { ...root, previousRootHash: prev?.rootHash ?? null, anchoredAt: Date.now() }
}
