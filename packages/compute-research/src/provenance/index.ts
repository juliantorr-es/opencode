import { captureSourceProvenance } from "./source.js";
import { collectBinaryProvenance } from "./binary.js";
import { captureModelProvenance } from "./model.js";
import { captureMachineProvenance } from "./machine.js";
import { captureEnvironmentProvenance } from "./environment.js";

export { captureSourceProvenance } from "./source.js";
export type { SourceProvenance } from "./source.js";
export { ProvenanceError, GitCommandError, ToolchainCommandError } from "./source.js";

export { collectBinaryProvenance } from "./binary.js";
export type { BinaryProvenance, BinaryArtifact } from "./binary.js";

export { captureModelProvenance } from "./model.js";
export type { ModelProvenance } from "./model.js";

export { captureMachineProvenance } from "./machine.js";
export type { MachineProvenance } from "./machine.js";

export { captureEnvironmentProvenance } from "./environment.js";
export type { EnvironmentProvenance } from "./environment.js";

/**
 * Capture the full provenance record combining all provenance modules
 * into one object matching provenance.v1.json.
 */
export async function captureFullProvenance(
  repoPath: string,
  computeNativeDir: string,
  modelDir: string,
): Promise<Record<string, unknown>> {
  const source = await captureSourceProvenance(repoPath);
  const binaries = await collectBinaryProvenance(computeNativeDir);
  const model = await captureModelProvenance(modelDir);
  const machine = await captureMachineProvenance();
  const environment = await captureEnvironmentProvenance();

  return {
    schema_version: "1",
    source: source.source,
    dependencies: source.dependencies,
    toolchain: source.toolchain,
    binaries: binaries.binaries,
    model,
    machine,
    environment,
  };
}
