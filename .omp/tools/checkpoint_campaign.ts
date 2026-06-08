import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function artifactLog(pi: { cwd: string }, ctx: { sessionId: string }, event: Record<string, unknown>): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/artifacts`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, `${sessionId}.v1.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch {}
}

function findEntityFile(worktree: string, entityDir: string, id: string): string | null {
  const dir = resolve(worktree, "docs/json/omp", entityDir);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  const match = files.find((f) => f.startsWith(`${id}-`) && f.endsWith(".v1.json"));
  return match ? resolve(dir, match) : null;
}

function captureGit(worktree: string): { commit: string | null; branch: string | null; dirty: boolean } {
  try {
    const commit = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 });
    const branch = spawnSync("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 5000 });
    const status = spawnSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8", timeout: 5000 });
    return {
      commit: commit.stdout?.trim() || null,
      branch: branch.stdout?.trim() || null,
      dirty: (status.stdout?.trim()?.length ?? 0) > 0,
    };
  } catch {
    return { commit: null, branch: null, dirty: false };
  }
}

const factory: CustomToolFactory = (pi) => ({
  name: "checkpoint_campaign",
  label: "Checkpoint Campaign",
  description: "Create a checkpoint snapshot of a campaign's current state. Captures the full entity JSON plus optional git state. Writes to docs/json/omp/checkpoints/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Campaign ID to checkpoint"),
    name: pi.zod.string().optional().describe("Checkpoint name (defaults to 'Auto-checkpoint')"),
    description: pi.zod.string().optional().describe("Checkpoint description"),
    captureGit: pi.zod.boolean().default(true).describe("Capture git commit/branch/dirty state"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("checkpoint_campaign cancelled");

    const filePath = findEntityFile(pi.cwd, "campaigns", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Campaign '${params.id}' does not exist` }], details: { checkpointId: null, status: "fail" } };
    }

    let campaign: Record<string, unknown>;
    try { campaign = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { checkpointId: null, status: "fail" } }; }

    const now = new Date().toISOString();
    const timestamp = now.replace(/[:.]/g, "-");
    const checkpointId = `campaign-${params.id}-${timestamp}`;
    const checkpointsDir = resolve(pi.cwd, "docs/json/omp/checkpoints");
    const checkpointPath = resolve(checkpointsDir, `${checkpointId}.v1.json`);

    const git = params.captureGit ? captureGit(pi.cwd) : { commit: null, branch: null, dirty: false };

    const checkpoint = {
      schema: "rig.relay.checkpoint.v1",
      schema_version: "v1",
      id: checkpointId,
      type: "checkpoint",
      entityType: "campaign",
      entityId: params.id,
      name: params.name || "Auto-checkpoint",
      description: params.description || `Checkpoint of campaign '${campaign.name || params.id}' at ${now}`,
      timestamp: now,
      stateSnapshot: campaign,
      gitCommit: git.commit,
      gitBranch: git.branch,
      gitDirty: git.dirty,
      status: "created",
      created_at: now,
    };

    try {
      mkdirSync(checkpointsDir, { recursive: true });
      writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
    } catch (e) { throw new Error(`Failed to write checkpoint: ${e}`); }

    const sizeBytes = Buffer.byteLength(JSON.stringify(checkpoint), "utf8");
    onUpdate?.({ content: [{ type: "text", text: `Checkpoint '${checkpointId}' created (${sizeBytes} bytes)` }], details: { status: "checkpointed", checkpointId, campaignId: params.id, sizeBytes } });
    artifactLog(pi, ctx, { action: "checkpoint_campaign", checkpointId, campaignId: params.id, sizeBytes, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Checkpoint '${checkpointId}' created for campaign ${params.id} (${sizeBytes} bytes)` }], details: { checkpointId, status: "checkpointed", sizeBytes } };
  },
});

export default factory;
