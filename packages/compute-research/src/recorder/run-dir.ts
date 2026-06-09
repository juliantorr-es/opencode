import { createHash } from "crypto";
import { closeSync, mkdirSync, openSync, writeSync, writeFileSync, fdatasyncSync } from "fs";
import { join, resolve } from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RunDirectoryConfig {
  /** If true, suppress warnings about missing schema validation. */
  readonly allowPartialArtifacts?: boolean;
}

export interface ArtifactResult {
  /** The generated artifact file name (within artifacts/). */
  readonly name: string;
  /** SHA-256 digest of the artifact content. */
  readonly sha256: string;
  /** Number of bytes written. */
  readonly byteSize: number;
  /** Full path on disk. */
  readonly path: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface OpenWrite {
  fd: number;
  path: string;
}

function openWrite(path: string): OpenWrite {
  const fd = openSync(path, "w");
  return { fd, path };
}

function writeJson(fd: number, data: unknown): void {
  const buf = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf-8");
  writeSync(fd, buf);
}

// ── RunDirectory ──────────────────────────────────────────────────────────────

export class RunDirectory {
  readonly runId: string;
  readonly root: string;
  readonly partialRoot: string;

  readonly receiptsDir: string;
  readonly checkpointsDir: string;
  readonly diagnosticsDir: string;
  readonly artifactsDir: string;

  private readonly opens: OpenWrite[];

  private readonly manifestFile: OpenWrite;
  private readonly provenanceFile: OpenWrite;
  private readonly workloadFile: OpenWrite;
  private readonly experimentPlanFile: OpenWrite;
  private readonly eventsFile: OpenWrite;

  private closed = false;

  constructor(
    runId: string,
    researchDataRoot: string,
    config?: RunDirectoryConfig,
  ) {
    this.runId = runId;
    this.root = resolve(researchDataRoot);
    this.partialRoot = join(this.root, `${runId}.partial`);

    this.receiptsDir = join(this.partialRoot, "receipts");
    this.checkpointsDir = join(this.partialRoot, "checkpoints");
    this.diagnosticsDir = join(this.partialRoot, "diagnostics");
    this.artifactsDir = join(this.partialRoot, "artifacts");

    // Create interlocking directory structure
    mkdirSync(this.partialRoot, { recursive: true });
    mkdirSync(this.receiptsDir, { recursive: true });
    mkdirSync(this.checkpointsDir, { recursive: true });
    mkdirSync(this.diagnosticsDir, { recursive: true });
    mkdirSync(this.artifactsDir, { recursive: true });

    // Open write streams for primary metadata files
    const opens: OpenWrite[] = [];

    this.manifestFile = openWrite(join(this.partialRoot, "run-manifest.json"));
    opens.push(this.manifestFile);

    this.provenanceFile = openWrite(join(this.partialRoot, "provenance.json"));
    opens.push(this.provenanceFile);

    this.workloadFile = openWrite(join(this.partialRoot, "workload.json"));
    opens.push(this.workloadFile);

    this.experimentPlanFile = openWrite(join(this.partialRoot, "experiment-plan.json"));
    opens.push(this.experimentPlanFile);

    this.eventsFile = openWrite(join(this.partialRoot, "events.jsonl"));
    opens.push(this.eventsFile);

    this.opens = opens;
  }

  // ── JSON metadata writers ───────────────────────────────────────────────

  writeRunManifest(manifest: object): void {
    this.assertNotClosed();
    writeJson(this.manifestFile.fd, manifest);
  }

  writeProvenance(prov: object): void {
    this.assertNotClosed();
    writeJson(this.provenanceFile.fd, prov);
  }

  writeWorkload(wl: object): void {
    this.assertNotClosed();
    writeJson(this.workloadFile.fd, wl);
  }

  writeExperimentPlan(plan: object): void {
    this.assertNotClosed();
    writeJson(this.experimentPlanFile.fd, plan);
  }

  // ── Event log (JSONL) ───────────────────────────────────────────────────

  appendEvent(event: object): void {
    this.assertNotClosed();
    const line = JSON.stringify(event) + "\n";
    writeSync(this.eventsFile.fd, Buffer.from(line, "utf-8"));
  }

  // ── Artifact storage ────────────────────────────────────────────────────

  /** Store a named artifact under `artifacts/{name}` and return metadata. */
  storeArtifact(name: string, data: string | Uint8Array): ArtifactResult {
    this.assertNotClosed();
    const dest = join(this.artifactsDir, name);
    const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    writeFileSync(dest, buf);

    const hash = createHash("sha256").update(buf).digest("hex");
    return { name, sha256: hash, byteSize: buf.length, path: dest };
  }

  // ── Flush ───────────────────────────────────────────────────────────────

  /** fsync all open file handles to durable storage. */
  flush(): void {
    this.assertNotClosed();
    for (const ow of this.opens) {
      try {
        fdatasyncSync(ow.fd);
      } catch {
        // best-effort — handle may already be closed
      }
    }
  }

  // ── Close ───────────────────────────────────────────────────────────────

  /** Close all open file handles. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const ow of this.opens) {
      try {
        closeSync(ow.fd);
      } catch {
        // best-effort — handle may already be closed
      }
    }
    this.opens.length = 0;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private assertNotClosed(): void {
    if (this.closed) {
      throw new Error(`RunDirectory ${this.runId} is already closed`);
    }
  }
}
