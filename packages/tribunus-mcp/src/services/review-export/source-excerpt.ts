// ─── Review Export — Source Excerpt Helpers ──────────────────────────────────

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { hashText, languageForPath, lineCountForText, normalizeLineBreaks } from "./fs-utils.js";
import type { SourceAnchorV1, SourceExcerptV1, ArtifactHeaderV1 } from "./types.js";


// ─── Helpers ─────────────────────────────────────────────────────────────────

function snippet(source: string, maxChars: number): string {
  const text = source.trim().replace(/\r\n/g, "\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function findFirstPatternAnchor(args: {
  path: string;
  text: string;
  patterns: RegExp[];
  symbolId?: string;
}): SourceAnchorV1 | undefined {
  const lines = normalizeLineBreaks(args.text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of args.patterns) {
      if (pattern.test(lines[i])) {
        return {
          path: args.path,
          start_line: i + 1,
          end_line: i + 1,
          sha256: hashText(args.text),
          language: languageForPath(args.path),
          ...(args.symbolId ? { symbol_id: args.symbolId } : {}),
        };
      }
    }
  }
  return undefined;
}

// ─── Source Excerpts ─────────────────────────────────────────────────────────

function createSourceExcerpt(args: {
  path: string;
  text: string;
  inclusion: "full" | "excerpt" | "signature_only" | "summary_only";
  reason: string;
  maxChars?: number;
  startLine?: number;
  endLine?: number;
  symbolId?: string;
  omittedReason?: string;
  line_count?: number;
  byte_count?: number;
}): SourceExcerptV1 {
  const maxChars = args.maxChars ?? 4000;
  const text = normalizeLineBreaks(args.text);
  const content = args.inclusion === "summary_only"
    ? undefined
    : args.inclusion === "signature_only"
      ? snippet(text, Math.min(maxChars, 400))
      : args.inclusion === "excerpt"
        ? snippet(text, maxChars)
        : text;
  const omitted_bytes = content ? Math.max(0, Buffer.byteLength(text, "utf8") - Buffer.byteLength(content, "utf8")) : Buffer.byteLength(text, "utf8");
  return {
    anchor: {
      path: args.path,
      start_line: args.startLine ?? 1,
      end_line: args.endLine ?? lineCountForText(text),
      sha256: hashText(text),
      language: languageForPath(args.path),
      ...(args.symbolId ? { symbol_id: args.symbolId } : {}),
    },
    inclusion: args.inclusion,
    reason: args.reason,
    line_count: args.line_count ?? lineCountForText(text),
    byte_count: args.byte_count ?? Buffer.byteLength(text, "utf8"),
    ...(content ? { content } : {}),
    ...(args.inclusion === "full" ? {} : { omitted_bytes }),
    ...(args.omittedReason ? { omitted_reason: args.omittedReason } : {}),
  };
}

// ─── V1 Artifact Headers ─────────────────────────────────────────────────────

const V1_PACKET_ID = "tribunus-gemini-ir";
const V1_GENERATOR_VERSION = "code_review_export@gemini_structured_ir_v1";

function createV1ArtifactHeader(args: {
  artifact_id: string;
  schema: string;
  generated_at: string;
  repo_root: string;
  git_branch?: string;
  git_head_sha?: string;
  dirty: boolean;
}): ArtifactHeaderV1 {
  return {
    schema: args.schema,
    packet_id: V1_PACKET_ID,
    artifact_id: args.artifact_id,
    generated_at: args.generated_at,
    repo_root_name: basename(args.repo_root),
    git_head_sha: args.git_head_sha,
    git_branch: args.git_branch,
    dirty: args.dirty,
    generator_version: V1_GENERATOR_VERSION,
  };
}

export { createSourceExcerpt, createV1ArtifactHeader, findFirstPatternAnchor };
