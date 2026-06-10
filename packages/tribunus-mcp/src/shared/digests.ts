import * as crypto from "node:crypto"

export function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

export function digestIfPresent(data: string): string | null {
  return data ? sha256Hex(data) : null
}
