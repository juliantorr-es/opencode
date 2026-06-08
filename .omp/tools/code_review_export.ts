// ─── Code Review Export — Orchestrator ─────────────────────────────────
//
// Thin orchestrator that routes export profiles to their builders.
// The heavy lifting lives in _lib/review-export/:
//   bootstrap-builder.ts  — bootstrap_review / gemini_code_review
//   gemini-ir-builder.ts  — gemini_ir / gemini_structured_ir_v1
//   gemini-attachment-builder.ts — gemini_zip_attachment
//
// The tool factory is still exported as default for consumers
// (_lib/code-intelligence/snapshot.ts).

import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { buildCodeReviewExport } from "./_lib/review-export/bootstrap-builder.js";
import buildGeminiIRArchive from "./_lib/review-export/gemini-ir-builder.js";
import { buildGeminiZipAttachment } from "./_lib/review-export/gemini-attachment-builder.js";
import { formatBytes } from "./_lib/review-export/fs-utils.js";
import { getPacketRoot, getZipName } from "./_lib/review-export/constants.js";
import { formatReviewExportProgress } from "./_lib/review-export/progress.js";

// ─── Receipt Logging ───────────────────────────────────────────────────

function artifactLog(
  pi: { cwd: string },
  ctx: { sessionId: string },
  event: Record<string, unknown>,
): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/artifacts`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      resolve(dir, `${sessionId}.v1.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
      "utf8",
    );
  } catch {
    // Silently fail
  }
}

function emitReviewExportProgress(
  onUpdate: ((value: { content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void) | undefined,
  event: Parameters<typeof formatReviewExportProgress>[0],
): void {
  onUpdate?.({
    content: [{ type: "text", text: formatReviewExportProgress(event) }],
    details: event,
  });
}

// ─── Factory ───────────────────────────────────────────────────────────

const factory: CustomToolFactory = (pi) => ({
  name: "code_review_export",
  label: "Export Code Review Bundle",
  description:
    "Creates a code_review.zip at the repo root containing all ADRs, board data (campaigns/missions/lanes/tasks), research context packets, memory links, repo source code filtered by inclusion policy, and a structured REVIEW_PACKET_MANIFEST.json. Uses a positive-inclusion-first policy model. Overwrites any existing code_review.zip.",

  parameters: pi.zod.object({
    include_untracked: pi.zod.boolean().optional().default(false),
    profile: pi.zod.enum([
      "bootstrap_review",
      "gemini_code_review",
      "gemini_zip_attachment",
      "gemini_ir",
      "gemini_structured_ir_v1",
    ]).optional().default("bootstrap_review"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("code_review_export cancelled");

    const w = pi.cwd;
    const profile = params.profile ?? "bootstrap_review";
    const packetRoot = getPacketRoot(profile);
    const sessionId = ctx.sessionId || "unknown";
    const now = new Date().toISOString();
    const exportStarted = performance.now();
    const timingsMs: Record<string, number> = {};

    // ── Profile: gemini_zip_attachment ──────────────────────────────────

    if (profile === "gemini_zip_attachment") {
      const zipPath = resolve(w, "tribunus-gemini-review.zip");
      const profileStarted = performance.now();
      const attachment = buildGeminiZipAttachment({
        repoRoot: w,
        packetRoot,
        zipPath,
        sessionId,
        now,
        includeUntracked: params.include_untracked,
      });
      const receipt: Record<string, unknown> = {
        schema: "omp.code_review_export_receipt.v1",
        action: "code_review_export",
        status: "ok",
        sessionId,
        exported_at: now,
        zip_path: zipPath,
        zip_size_bytes: attachment.zipSize,
        zip_sha256: attachment.zipSha256,
        counts: {
          included_files: attachment.includedFiles.length,
          excluded_files: 0,
          oversized_files: 0,
          missing_expected_files: 0,
          adrs_json: 0, adrs_markdown: 0,
          campaigns: 0, missions: 0, lanes: 0, tasks: 0,
          research: 0, memory_links: 0,
        },
        warnings_count: attachment.warnings.length,
        warnings: attachment.warnings,
        git: { branch: attachment.branch, head_sha: attachment.headSha, is_dirty: attachment.isDirty },
        timings_ms: { total: Math.max(0, Math.round(performance.now() - profileStarted)) },
      };
      artifactLog(pi, ctx, receipt);
      return {
        content: [{
          type: "text",
          text:
            `Gemini web attachment bundle exported:\n` +
            `  tribunus-gemini-review.zip (${formatBytes(attachment.zipSize)})\n` +
            `  10 attachment files\n` +
            `  Use the full code-folder profile for path-preserving review.\n`,
        }],
        details: {
          status: "ok", zipPath, zipSize: attachment.zipSize,
          zipSha256: attachment.zipSha256,
          fileCount: attachment.includedFiles.length,
          warningsCount: attachment.warnings.length,
          timings_ms: { total: Math.max(0, Math.round(performance.now() - profileStarted)) },
        },
      };
    }

    // ── Profile: gemini_ir / gemini_structured_ir_v1 ───────────────────

    if (profile === "gemini_ir" || profile === "gemini_structured_ir_v1") {
      const zipPath = resolve(w, "tribunus-gemini-ir.zip");
      const profileStarted = performance.now();
      const ir = await buildGeminiIRArchive({
        repoRoot: w,
        packetRoot: "tribunus-gemini-ir",
        zipPath,
        now,
        includeUntracked: params.include_untracked,
        reviewScope: /release|ui/i.test(profile) ? "release_ui" : "general",
      });
      const receipt: Record<string, unknown> = {
        schema: "omp.code_review_export_receipt.v1",
        action: "code_review_export",
        status: "ok",
        sessionId,
        exported_at: now,
        zip_path: zipPath,
        zip_size_bytes: ir.zipSize,
        zip_sha256: ir.zipSha256,
        counts: {
          included_files: ir.includedFiles.length, excluded_files: 0,
          oversized_files: 0, missing_expected_files: 0,
          adrs_json: 0, adrs_markdown: 0,
          campaigns: 0, missions: 0, lanes: 0, tasks: 0,
          research: 0, memory_links: 0,
        },
        warnings_count: ir.warnings.length,
        warnings: ir.warnings,
        git: { branch: undefined, head_sha: undefined, is_dirty: false },
        timings_ms: { total: Math.max(0, Math.round(performance.now() - profileStarted)) },
      };
      artifactLog(pi, ctx, receipt);
      return {
        content: [{
          type: "text",
          text:
            `Gemini IR bundle exported:\n` +
            `  tribunus-gemini-ir.zip (${formatBytes(ir.zipSize)})\n` +
            `  10 JSON artifacts\n` +
            `  Use this as the semantic review packet.\n`,
        }],
        details: {
          status: "ok", zipPath, zipSize: ir.zipSize,
          zipSha256: ir.zipSha256,
          fileCount: ir.includedFiles.length,
          warningsCount: ir.warnings.length,
          timings_ms: { total: Math.max(0, Math.round(performance.now() - profileStarted)) },
        },
      };
    }

    // ── Profile: bootstrap_review / gemini_code_review ─────────────────

    emitReviewExportProgress(onUpdate, {
      stage: "discover",
      status: "start",
      message: "Reading ADRs and board data...",
    });

    const result = buildCodeReviewExport({
      repoRoot: w,
      profile: profile as "bootstrap_review" | "gemini_code_review",
      includeUntracked: params.include_untracked,
      onProgress: (event) => emitReviewExportProgress(onUpdate, event),
      signal: signal ?? undefined,
    });

    // ── Receipt ────────────────────────────────────────────────────────

    timingsMs.complete = Math.max(0, Math.round(performance.now() - exportStarted));

    const receipt: Record<string, unknown> = {
      schema: "omp.code_review_export_receipt.v1",
      action: "code_review_export",
      status: "ok",
      sessionId,
      exported_at: now,
      zip_path: result.zipPath,
      zip_size_bytes: result.zipSize,
      zip_sha256: result.zipSha256,
      counts: {
        included_files: result.includedFiles.length,
        excluded_files: result.exclusionEntries.length,
        oversized_files: result.oversizedFiles.length,
        missing_expected_files: result.missingExpected.length,
        adrs_json: result.adrsJson.length,
        adrs_markdown: result.adrsMarkdown.length,
        campaigns: result.campaigns.length,
        missions: result.missions.length,
        lanes: result.lanes.length,
        tasks: result.tasks.length,
        research: result.research.length,
        memory_links: result.memoryLinks.length,
      },
      warnings_count: result.warnings.length,
      warnings: result.warnings,
      git: { branch: result.gitBranch, head_sha: result.gitHeadSha, is_dirty: result.isDirty },
      timings_ms: { ...result.timingsMs, complete: timingsMs.complete },
    };

    artifactLog(pi, ctx, receipt);

    emitReviewExportProgress(onUpdate, {
      stage: "complete",
      status: "done",
      semantic_zip: result.zipPath,
      warnings_count: result.warnings.length,
      critical_count: 0,
      message: `Exported ${getZipName(profile)} (${formatBytes(result.zipSize)}, ${result.includedFiles.length} files)`,
    });

    return {
      content: [{
        type: "text",
        text:
          `Code review bundle exported:\n` +
          `  ${getZipName(profile)} (${formatBytes(result.zipSize)})\n` +
          `  ${result.includedFiles.length} files: ${result.adrsJson.length} ADR JSONs, ${result.adrsMarkdown.length} ADR markdowns, ` +
          `${result.campaigns.length} campaigns, ${result.missions.length} missions, ${result.lanes.length} lanes, ` +
          `${result.tasks.length} tasks, ${result.research.length} research packets, ${result.memoryLinks.length} memory links\n` +
          `  ${result.exclusionEntries.length} excluded, ${result.oversizedFiles.length} oversized, ${result.missingExpected.length} missing expected\n` +
          (result.warnings.length > 0 ? `  ⚠ ${result.warnings.length} warning(s) — see REVIEW_PACKET_WARNINGS.md\n` : "") +
          `  REVIEW_PACKET_MANIFEST.json with SHA-256 file inventory\n` +
          `  Zip SHA-256: ${result.zipSha256}`,
      }],
      details: {
        status: "ok",
        zipPath: result.zipPath,
        zipSize: result.zipSize,
        zipSha256: result.zipSha256,
        fileCount: result.includedFiles.length,
        excludedCount: result.exclusionEntries.length,
        oversizedCount: result.oversizedFiles.length,
        missingExpectedCount: result.missingExpected.length,
        warningsCount: result.warnings.length,
        sourceFiles: result.includedFiles.filter((f: { category: string }) => f.category === "source").length,
        ompFiles: result.includedFiles.filter((f: { category: string }) => f.category === "omp").length,
        adrsJson: result.adrsJson.length,
        adrsMarkdown: result.adrsMarkdown.length,
        campaigns: result.campaigns.length,
        missions: result.missions.length,
        lanes: result.lanes.length,
        tasks: result.tasks.length,
        research: result.research.length,
        memoryLinks: result.memoryLinks.length,
        timings_ms: { ...result.timingsMs, complete: timingsMs.complete },
      },
    };
  },
});

export default factory;
