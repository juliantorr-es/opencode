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
 *   V3 (OPT-0002) — [proj] projection_stage events: graph_build_ns, shapes,
 *                    dtypes, group_size, bits, transpose, family (q/k/v/o/gate/up/down)
 * Auto-detected: V3 is selected when the line starts with "[proj]".
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
              measurements: Object.assign(
                {},
                // Backward-compatible keys used by the normalizer's MemorySampleRecord columns.
                // Emitted as null (not 0) when the metric was not observed.
                rssAfterM ? { resident_bytes: Math.round(parseMem(rssAfterM[1]!)) } : null,
                activeAfterM ? { active_bytes: Math.round(parseMem(activeAfterM[1]!)) } : null,
                // MLX-specific fields stored in the measurements JSON blob.
                // mlx_active_bytes  = MLX allocator active memory (Metal buffer pool).
                // mlx_cache_bytes  = MLX allocator cache memory.
                // wired_bytes and compressed_bytes are NEVER emitted —
                // they are not measured by V2 instrumentation.
                activeAfterM ? { mlx_active_bytes: Math.round(parseMem(activeAfterM[1]!)) } : null,
                cacheAfterM ? { mlx_cache_bytes: Math.round(parseMem(cacheAfterM[1]!)) } : null,
              ) as Record<string, unknown>,
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

    // ── V3 grammar (projection events) ──
    // Field-order independent key=value extraction, same as V1/V2.
    // Format: [proj] run_id=... phase=... forward_pass=... token_step=...
    //         layer=... kind=... family=... invocation=... graph_build_ns=...
    //         input=[d0,d1] weight_logical=[d0,d1] weight_physical=[d0,d1]
    //         storage_dtype=... runtime_dtype=... group_size=... bits=... transpose=...
    if (line.startsWith("[proj]")) {
      const layerProjM = line.match(/layer=(\d+)/);
      const kindProjM = line.match(/kind=(\S+)/);
      const familyM = line.match(/family=(\S+)/);
      const invocationM = line.match(/invocation=(\d+)/);
      const graphBuildNsM = line.match(/graph_build_ns=(\d+)/);
      const inputShapeM = line.match(/input=\[(\d+),(\d+)\]/);
      const weightLogicalShapeM = line.match(/weight_logical=\[(\d+),(\d+)\]/);
      const weightPhysicalShapeM = line.match(/weight_physical=\[(\d+),(\d+)\]/);
      const storageDtypeM = line.match(/storage_dtype=(\S+)/);
      const runtimeDtypeM = line.match(/runtime_dtype=(\S+)/);
      const groupSizeM = line.match(/group_size=(\d+)/);
      const bitsM = line.match(/bits=(\d+)/);
      const transposeM = line.match(/transpose=(true|false)/);

      if (layerProjM && kindProjM && familyM) {
        const layerIndex = parseInt(layerProjM[1]!);
        const kind = kindProjM[1]!;
        const family = familyM[1]!;
        const invocation = invocationM ? parseInt(invocationM[1]!) : undefined;

        let stageId: string;
        if (currentPhase === "decode_step" && tokenStep !== null) {
          stageId = `decode_step_${tokenStep}_layer_${layerIndex}_${family}`;
        } else {
          stageId = `${currentPhase}_layer_${layerIndex}_${family}`;
        }

        // Build measurements — absent fields are OMITTED (never zero)
        const measurements: Record<string, unknown> = {
          grammar_version: "v3",
        };
        if (graphBuildNsM) measurements.projection_graph_build_ns = parseInt(graphBuildNsM[1]!);
        if (inputShapeM) measurements.input_shape = [parseInt(inputShapeM[1]!), parseInt(inputShapeM[2]!)];
        if (weightLogicalShapeM) measurements.weight_logical_shape = [parseInt(weightLogicalShapeM[1]!), parseInt(weightLogicalShapeM[2]!)];
        if (weightPhysicalShapeM) measurements.weight_physical_shape = [parseInt(weightPhysicalShapeM[1]!), parseInt(weightPhysicalShapeM[2]!)];
        if (storageDtypeM) measurements.storage_dtype = storageDtypeM[1]!;
        if (runtimeDtypeM) measurements.runtime_dtype = runtimeDtypeM[1]!;
        if (groupSizeM) measurements.group_size = parseInt(groupSizeM[1]!);
        if (bitsM) measurements.bits = parseInt(bitsM[1]!);
        if (transposeM) measurements.transpose = transposeM[1] === "true";

        events.push({
          schema_version: "1.0",
          run_id: runId,
          request_id: runId,
          worker_id: "worker-1",
          sequence_number: events.length + 1,
          event_type: "projection_stage",
          clock_domain: "worker_monotonic",
          monotonic_ns: 0,
          stage: {
            stage_id: stageId,
            substrate_id: "mlx_generic_gpu",
            layer_index: layerIndex,
            attention_kind: kind,
            status: "completed",
            phase: currentPhase || undefined,
            forward_pass_index: forwardPassIndex || undefined,
            token_step: tokenStep ?? undefined,
            projection_family: family,
            projection_invocation: invocation,
            storage_dtype: storageDtypeM ? storageDtypeM[1]! : undefined,
            runtime_dtype: runtimeDtypeM ? runtimeDtypeM[1]! : undefined,
            input_shape: inputShapeM ? [parseInt(inputShapeM[1]!), parseInt(inputShapeM[2]!)] : undefined,
            weight_logical_shape: weightLogicalShapeM ? [parseInt(weightLogicalShapeM[1]!), parseInt(weightLogicalShapeM[2]!)] : undefined,
            weight_physical_shape: weightPhysicalShapeM ? [parseInt(weightPhysicalShapeM[1]!), parseInt(weightPhysicalShapeM[2]!)] : undefined,
            group_size: groupSizeM ? parseInt(groupSizeM[1]!) : undefined,
            bits: bitsM ? parseInt(bitsM[1]!) : undefined,
            transpose: transposeM ? transposeM[1] === "true" : undefined,
            measurements,
          },
        });
      }
    }
  }
  return events;
}
