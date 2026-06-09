/**
 * Standard layer-event parser — extracts structured events from Rust test stderr.
 *
 * Field-order independent: uses individual key=value lookups, not positional regex.
 * Phase-aware: tracks prefill/decode_step phases via [phase] markers.
 *
 * Imported by both the E0000 orchestrator and the parser-contract tests.
 */

export interface StandardLayerEvent {
  schema_version: string
  run_id: string
  request_id: string
  worker_id: string
  sequence_number: number
  event_type: string
  clock_domain: string
  monotonic_ns: number
  stage: {
    stage_id: string
    substrate_id: string
    layer_index: number
    attention_kind: string
    status: string
    phase?: string
    forward_pass_index?: number
    token_step?: number
    measurements: {
      eval_ns: number
      file_read_bytes: number
      materialized_bytes: number
      kv_delta: number
    }
  }
}

/** Parse per-layer events from the stderr format used by all model tests. */
export function parseStandardLayerEvents(
  stderr: string,
  runId: string,
): StandardLayerEvent[] {
  const events: StandardLayerEvent[] = [];
  let currentPhase = "";
  let forwardPassIndex = 0;
  let tokenStep: number | null = null;

  for (const line of stderr.split("\n")) {
    // Track phase markers
    const phaseStart = line.match(/\[phase\]\s+(\S+)\s+start(?:\s+token_step=(\d+))?/);
    if (phaseStart) {
      forwardPassIndex++;
      if (phaseStart[1] === "prefill") {
        tokenStep = null;
      } else if (phaseStart[1] === "decode_step") {
        tokenStep = phaseStart[2] ? parseInt(phaseStart[2]!) : null;
      }
      currentPhase = phaseStart[1]!;
      continue;
    }
    if (line.match(/\[phase\]\s+\S+\s+end/)) continue;

    // Parse layer event line — key=value extraction (field-order independent)
    const layerM = line.match(/layer=(\d+)/);
    const kindM = line.match(/kind=(\S+)/);
    const shapeM = line.match(/shape=\[(\d+),\s*(\d+)\]/);
    const finiteM = line.match(/finite=(true|false)/);
    // Optional: extract real measurements when present
    const elapsedM = line.match(/elapsed_ms=(\d+)/);
    const bytesM = line.match(/bytes=(\d+)/);
    if (layerM && kindM && shapeM && finiteM) {
      const layerIndex = parseInt(layerM[1]!);
      const evalNs = elapsedM ? parseInt(elapsedM[1]!) * 1_000_000 : 0;
      const fileBytes = bytesM ? parseInt(bytesM[1]!) : 0;
      let stageId: string;
      if (currentPhase === "decode_step" && tokenStep !== null) {
        stageId = `decode_step_${tokenStep}_layer_${layerIndex}`;
      } else {
        stageId = `layer_${layerIndex}`;
      }
      events.push({
        schema_version: "1.0",
        run_id: runId,
        request_id: runId,
        worker_id: "worker-1",
        sequence_number: events.length + 1,
        event_type: "stage",
        clock_domain: "worker_monotonic",
        monotonic_ns: 0,
        stage: {
          stage_id: stageId,
          substrate_id: "mlx_generic_gpu",
          layer_index: layerIndex,
          attention_kind: kindM[1]!,
          status: finiteM[1] === "true" ? "completed" : "failed",
          phase: currentPhase || undefined,
          forward_pass_index: forwardPassIndex || undefined,
          token_step: tokenStep ?? undefined,
          measurements: {
            eval_ns: evalNs,
            file_read_bytes: fileBytes,
            materialized_bytes: 0,
            kv_delta: 0,
          },
        },
      });
    }
  }
  return events;
}
