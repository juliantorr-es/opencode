// ─── Review Export Types ─────────────────────────────────────────────────────

import type { Node, Parser, Language } from "web-tree-sitter";

interface CodeReviewPacketManifestV1 {
  schema: "omp.code_review_packet_manifest.v1";
  created_at: string;
  repo_root: string;
  git: {
    branch?: string;
    head_sha?: string;
    is_dirty: boolean;
    status_path: string;
    diff_path?: string;
  };
  policy: {
    include_sets: string[];
    exclude_sets: string[];
    max_file_bytes: number;
    oversized_file_policy: "omit_with_manifest" | "truncate_with_marker" | "include";
  };
  counts: {
    included_files: number;
    excluded_files: number;
    oversized_files: number;
    missing_expected_files: number;
    unresolved_imports: number;
  };
  required_paths: Array<{
    path: string;
    status: "included" | "missing" | "excluded" | "oversized";
    reason?: string;
  }>;
  files: Array<{
    path: string;
    size_bytes: number;
    sha256: string;
    category: string;
  }>;
  exclusions: Array<{
    path: string;
    reason: string;
    size_bytes?: number;
  }>;
  warnings: string[];
}

type CodeReviewExportProfile =
  | "bootstrap_review"
  | "gemini_code_review"
  | "gemini_zip_attachment"
  | "gemini_ir"
  | "gemini_structured_ir_v1";

interface FileEntry {
  path: string;
  size_bytes: number;
  sha256: string;
  category: string;
}

interface ExclusionEntry {
  path: string;
  reason: string;
  size_bytes?: number;
}

interface ImportFinding {
  importer: string;
  specifier: string;
  resolved?: string;
  kind: "remap" | "missing" | "external" | "not_included";
}

type ReviewScope = "general" | "release_ui";

type GateCheckStatusV1 = "pass" | "fail" | "warning" | "not_checked";

interface SourceAnchorV1 {
  path: string;
  start_line?: number;
  end_line?: number;
  sha256: string;
  language?: string;
  symbol_id?: string;
}

interface SourceExcerptV1 {
  anchor: SourceAnchorV1;
  inclusion: "full" | "excerpt" | "signature_only" | "summary_only";
  reason: string;
  line_count?: number;
  byte_count?: number;
  content?: string;
  omitted_bytes?: number;
  omitted_reason?: string;
}

interface ArtifactHeaderV1 {
  schema: string;
  packet_id: string;
  artifact_id: string;
  generated_at: string;
  repo_root_name: string;
  git_head_sha?: string;
  git_branch?: string;
  dirty: boolean;
  generator_version: string;
}

export type {
  CodeReviewPacketManifestV1,
  CodeReviewExportProfile,
  FileEntry,
  ExclusionEntry,
  ImportFinding,
  ReviewScope,
  GateCheckStatusV1,
  SourceAnchorV1,
  SourceExcerptV1,
  ArtifactHeaderV1,
};
