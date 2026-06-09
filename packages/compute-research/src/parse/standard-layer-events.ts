/**
 * Standard layer-event parser — extracts structured events from Rust test stderr.
 *
 * Field-order independent: uses individual key=value lookups, not positional regex.
 * Phase-aware: tracks prefill/decode_step phases via [phase] markers.
 *
 * Grammar versions:
 *   V1 (original) — elapsed_ms, bytes, shape=[N,N], finite=true/false
 *   V2 (OPT-0001) — graph_us, eval_us, rss=A→B, active=X→Y, cache=P→Q,
 *                    kv_seq, kv_copy, kv_alloc, shape=[N,N], finite=true/false
 * Auto-detected: V2 is selected when the line contains graph_us=.
 *
 * Imported by both the E0000 orchestrator and the parser-contract tests.
 */

/** Parse per-layer events from the stderr format used by all model tests. */
export function parseStandardLayerEvents(
  stderr: string,
  runId: string,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
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
    if (layerM && kindM && shapeM && finiteM) {
       const layerIndex = parseInt(layerM[1]!);
       let stageId: string;
      if (currentPhase === "decode_step" && tokenStep !== null) {
        stageId = `decode_step_${tokenStep}_layer_${layerIndex}`;
      } else {
        stageId = `layer_${layerIndex}`;
      }
       const grammarV2 = line.includes("graph_us=");
       let measurements: Record<string, unknown>;
       if (grammarV2) {
         // ── V2 grammar (OPT-0001 instrumentation) ──
         const graphUsM = line.match(/graph_us=(\d+)/);
         const evalUsM = line.match(/eval_us=(\d+)/);
         const kvSeqM = line.match(/kv_seq=(\d+)/);
         const kvCopyM = line.match(/kv_copy=(\d+)/);
         const kvAllocM = line.match(/kv_alloc=(\d+)/);
         const graphNs = graphUsM ? parseInt(graphUsM[1]!) * 1000 : 0;
         const evalNs = evalUsM ? parseInt(evalUsM[1]!) * 1000 : 0;
         measurements = {
           grammar_version: "v2",
           graph_build_ns: graphNs,
           eval_ns: evalNs,
           total_ns: graphNs + evalNs,
         };
        // Only include KV fields when present in the trace
        if (kvSeqM) (measurements as Record<string, unknown>).kv_seq_len = parseInt(kvSeqM[1]!);
        if (kvCopyM) (measurements as Record<string, unknown>).kv_copy_bytes = parseInt(kvCopyM[1]!);
        if (kvAllocM) (measurements as Record<string, unknown>).kv_alloc_bytes = parseInt(kvAllocM[1]!);
         // Emit a companion memory_sample for RSS/MLX telemetry
         const rssAfterM = line.match(/rss=\S+→(\S+)/);
         const activeAfterM = line.match(/active=\S+→(\S+)/);
         const cacheAfterM = line.match(/cache=\S+→(\S+)/);
         if (rssAfterM || activeAfterM || cacheAfterM) {
           const parseMem = (s: string) => {
             if (s.endsWith("GB")) return parseFloat(s) * 1073741824;
             if (s.endsWith("MB")) return parseFloat(s) * 1048576;
             if (s.endsWith("KB")) return parseFloat(s) * 1024;
             if (s.endsWith("B")) return parseFloat(s);
             return parseFloat(s) || 0;
           };
           events.push({
             schema_version: "1.0",
             run_id: runId,
             request_id: runId,
             worker_id: "worker-1",
             sequence_number: events.length + 1,
             event_type: "memory_sample",
             clock_domain: "worker_monotonic",
             monotonic_ns: 0,
             stage: {
               stage_id: `${stageId}_mem`,
               substrate_id: "mlx_generic_gpu",
               layer_index: layerIndex,
               attention_kind: kindM[1]!,
               status: "completed",
               phase: currentPhase || undefined,
               forward_pass_index: forwardPassIndex || undefined,
               measurements: {
                // Backward-compatible keys used by the normalizer's MemorySampleRecord columns
                resident_bytes: rssAfterM ? Math.round(parseMem(rssAfterM[1]!)) : 0,
                active_bytes: activeAfterM ? Math.round(parseMem(activeAfterM[1]!)) : 0,
                // MLX-specific fields stored in the measurements JSON blob.
                // mlx_active_bytes  = MLX allocator active memory (Metal buffer pool).
                // mlx_cache_bytes  = MLX allocator cache memory, NOT macOS compressed.
                // wired_bytes      = 0 (not measured in V2 instrumentation).
                // compressed_bytes = 0 (not measured; do not interpret as MLX cache).
                mlx_active_bytes: activeAfterM ? Math.round(parseMem(activeAfterM[1]!)) : null,
                mlx_cache_bytes: cacheAfterM ? Math.round(parseMem(cacheAfterM[1]!)) : null,
                wired_bytes: 0,
                compressed_bytes: 0,
               } as Record<string, unknown>,
             },
           });
         }
       } else {
         // ── V1 grammar (original E0000 format) ──
         const elapsedM = line.match(/elapsed_ms=(\d+)/);
         const bytesM = line.match(/bytes=(\d+)/);
        const evalNs = elapsedM ? parseInt(elapsedM[1]!) * 1_000_000 : 0;
         measurements = {
           grammar_version: "v1",
          eval_ns: evalNs,
          total_ns: evalNs,
         };
        if (bytesM) (measurements as Record<string, unknown>).file_read_bytes = parseInt(bytesM[1]!);
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
           measurements,
         },
       });
    }
  }
  return events;
}
