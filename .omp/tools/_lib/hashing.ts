import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export function fileSha256(path: string): string {
  const buf = readFileSync(path)
  return createHash("sha256").update(buf).digest("hex")
}

export function shortHash(inputs: string[]): string {
  return sha256(inputs.join("|")).slice(0, 8)
}

export function sha256Bytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export { stableJson } from "./json.js"

export function sha256Json(value: unknown): string {
  return sha256(stableJson(value))
}
