// ─── Gemini Attachment Builder ────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createZipCliArchiveBackend } from "./archive.js";
import { gitExec } from "./git.js";
import type { FileEntry } from "./types.js";

export function buildGeminiZipAttachment(args: {
  repoRoot: string;
  packetRoot: string;
  zipPath: string;
  sessionId: string;
  now: string;
  includeUntracked: boolean;
}): {
  includedFiles: FileEntry[];
  warnings: string[];
  zipSha256: string;
  zipSize: number;
  branch?: string;
  headSha?: string;
  isDirty: boolean;
  diffPath?: string;
} {
  const warnings: string[] = [];
  const tmpDir = resolve(tmpdir(), `tribunus-gemini-attachment-${Date.now()}`);
  const root = resolve(tmpDir, args.packetRoot);
  mkdirSync(root, { recursive: true });

  const branchResult = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], args.repoRoot);
  const shaResult = gitExec(["rev-parse", "HEAD"], args.repoRoot);
  const statusResult = gitExec(["status", "--porcelain"], args.repoRoot);
  const isDirty = statusResult.ok && statusResult.stdout.trim().length > 0;
  const gitStatusResult = gitExec(["status"], args.repoRoot);
  const diffResult = isDirty ? gitExec(["diff"], args.repoRoot) : { ok: true, stdout: "", stderr: "" };

  const files: Array<{ path: string; content: string }> = [
    {
      path: "01_REVIEW_GUIDE.md",
      content: [
        "# Gemini Web Review Guide",
        "",
        "This ZIP is optimized for Gemini web's generic attachment path.",
        "It is intentionally capped at 10 files.",
        "",
        "Primary review focus:",
        "",
        "- OMP tool kernel",
        "- PGlite mutation transactionality",
        "- path locking and receipts",
        "- manifest honesty",
        "- export completeness",
        "",
      ].join("\n"),
    },
    {
      path: "02_OMP_TOOLS_AND_KERNEL.md",
      content: "# OMP Tools and Kernel\n\nReview the .omp/tools public tools and _lib kernel together.\n",
    },
    {
      path: "03_PGLITE_DUCKDB_STORE.md",
      content: "# PGlite and DuckDB Store\n\nFocus on transaction boundaries, mutation recording, and projector integrity.\n",
    },
    {
      path: "04_MANIFESTS_AND_MCP.md",
      content: "# Manifests and MCP\n\nReview tool manifests, authority classification, and OMP boundaries.\n",
    },
    {
      path: "05_TESTS.md",
      content: "# Tests\n\nThe export-completeness suite and store regression tests are the main review anchors.\n",
    },
    {
      path: "06_REPO_CONTEXT.md",
      content: [
        "# Repo Context",
        "",
        `Branch: ${branchResult.ok ? branchResult.stdout.trim() : "(unknown)"}`,
        `Commit: ${shaResult.ok ? shaResult.stdout.trim() : "(unknown)"}`,
        `Dirty: ${isDirty ? "yes" : "no"}`,
        "",
      ].join("\n"),
    },
    {
      path: "07_ARCHITECTURE_ARTIFACTS.md",
      content: "# Architecture Artifacts\n\nSee docs/adr, docs/json/adrs, docs/schemas, and governance docs in the repo root packet.\n",
    },
    {
      path: "08_EXPORT_MANIFEST.md",
      content: "# Export Manifest\n\nThis attachment is intentionally small. Use the full code-folder profile for path-preserving review.\n",
    },
    {
      path: "09_UNRESOLVED_IMPORTS.md",
      content: "# Unresolved Imports\n\nThis bundle does not include full source trees. Use the code-folder export for dependency-closure review.\n",
    },
    {
      path: "10_GIT_DIFF.patch",
      content: [
        "# Git Status",
        "",
        gitStatusResult.ok ? gitStatusResult.stdout : gitStatusResult.stderr,
        "",
        "# Git Diff",
        "",
        diffResult.ok ? (diffResult.stdout || "(clean tree)\n") : diffResult.stderr,
        "",
      ].join("\n"),
    },
  ];

  const includedFiles: FileEntry[] = [];
  for (const file of files) {
    const buf = Buffer.from(file.content, "utf8");
    writeFileSync(resolve(root, file.path), buf);
    includedFiles.push({
      path: file.path,
      size_bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      category: "attachment",
    });
  }

  const archive = createZipCliArchiveBackend()
  const zipResult = archive.zipDirectory({
    source_dir: root,
    archive_path: args.zipPath,
    stage: "semantic_zip",
  })
  return { includedFiles, warnings, zipSha256: zipResult.sha256, zipSize: zipResult.size_bytes, branch: branchResult.ok ? branchResult.stdout.trim() : undefined, headSha: shaResult.ok ? shaResult.stdout.trim() : undefined, isDirty };
}
