import { createHash } from "node:crypto"
import type { SourceAnchorV1, SourceExcerptV1 } from "./store/code-index-types.js"

export function makeSourceAnchor(input: {
  path: string
  text: string
  start?: number
  end?: number
  language?: string
  symbol_id?: string
}): SourceAnchorV1 {
  const start = input.start ?? 0
  const end = input.end ?? input.text.length
  return {
    path: input.path,
    sha256: createHash("sha256").update(input.text, "utf8").digest("hex"),
    start_byte: start,
    end_byte: end,
    language: input.language,
    symbol_id: input.symbol_id,
    start_line: input.text.slice(0, start).split(/\r?\n/).length,
    end_line: input.text.slice(0, end).split(/\r?\n/).length,
  }
}

export function makeSourceExcerpt(input: {
  anchor: SourceAnchorV1
  content?: string
  inclusion: SourceExcerptV1["inclusion"]
  reason: string
  omitted_reason?: string
}): SourceExcerptV1 {
  const content = input.content ?? ""
  return {
    anchor: input.anchor,
    inclusion: input.inclusion,
    reason: input.reason,
    content: input.content,
    line_count: content ? content.split(/\r?\n/).length : undefined,
    byte_count: Buffer.byteLength(content, "utf8"),
    omitted_reason: input.omitted_reason,
    omitted_bytes: input.omitted_reason ? 0 : undefined,
  }
}
