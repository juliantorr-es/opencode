import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import type { ArtifactManifest } from "./types.js"

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

export async function fileDigest(path: string): Promise<{ digest: string; byteCount: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    let byteCount = 0
    const stream = createReadStream(path)
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      hash.update(buf)
      byteCount += buf.length
    })
    stream.on("end", () => resolve({ digest: hash.digest("hex"), byteCount }))
    stream.on("error", reject)
  })
}

export function bufferDigest(data: Buffer): { digest: string; byteCount: number } {
  return { digest: sha256Hex(data), byteCount: data.length }
}

export function manifestDigest(manifest: ArtifactManifest): string {
  const canonical = JSON.stringify(manifest, (_, v) => v === undefined ? null : v, 2)
  return sha256Hex(canonical)
}

export function canonicalJson(data: unknown): string {
  return JSON.stringify(data, (_, v) => v === undefined ? null : v)
}
