// @ts-nocheck — tests access nested Record<string,unknown> fields
/**
 * Parser-contract tests: verify parseStandardLayerEvents correctly parses
 * literal output lines from both Rust emitters.
 *
 * These tests catch field-order, regex, and phase-tracking mismatches
 * without requiring a 46-minute model run.
 */

import { test, expect } from "bun:test";

import { parseStandardLayerEvents } from "../src/parse/standard-layer-events.js";

// ── Tests ───────────────────────────────────────────────────────────────────

test("ImageRuntime format — real_checkpoint_full_model_gate output", () => {
  // Literal from compute_image.rs line 2710
  const stderr = [
    "[full-model] layer=0 kind=sliding_attention segment=s0 bytes=0 elapsed_ms=1800 handles=4→5→4 active_mem=1.2→1.3 shape=[1,3840] finite=true",
    "[full-model] layer=47 kind=full_attention segment=s5 bytes=0 elapsed_ms=2100 handles=4→6→4 active_mem=1.5→1.6 shape=[1,3840] finite=true",
  ].join("\n");

  const events = parseStandardLayerEvents(stderr, "run-1");
  expect(events.length).toBe(2);
  expect(events[0]!.stage).toMatchObject({ layer_index: 0, attention_kind: "sliding_attention" });
  expect(events[1]!.stage).toMatchObject({ layer_index: 47, attention_kind: "full_attention" });
});

test("ProfiledInferenceSession format — prefill + decode_one output", () => {
  // Literal from profiled_executor.rs prefill() and decode_one() eprintln!s
  const stderr = [
    "[phase] prefill start",
    "[full-model] layer=0 kind=sliding_attention segment=mapped bytes=0 elapsed_ms=0 handles=0 active_mem=N/A shape=[1,3840] finite=true",
    "[full-model] layer=47 kind=full_attention segment=mapped bytes=0 elapsed_ms=0 handles=0 active_mem=N/A shape=[1,3840] finite=true",
    "[phase] prefill end",
    "[phase] decode_step start token_step=0",
    "[full-model] layer=0 kind=sliding_attention segment=mapped bytes=0 elapsed_ms=0 handles=0 active_mem=N/A shape=[1,3840] finite=true",
    "[phase] decode_step end",
  ].join("\n");

  const events = parseStandardLayerEvents(stderr, "run-2");
  expect(events.length).toBe(3); // 2 prefill + 1 decode

  // Prefill events
  expect(events[0]!.stage).toMatchObject({
    layer_index: 0,
    phase: "prefill",
    forward_pass_index: 1,
  });
  expect(events[1]!.stage).toMatchObject({
    layer_index: 47,
    phase: "prefill",
    forward_pass_index: 1,
  });

  // Decode event
  expect(events[2]!.stage).toMatchObject({
    layer_index: 0,
    phase: "decode_step",
    forward_pass_index: 2,
    token_step: 0,
  });
  expect(events[2]!.stage.stage_id).toBe("decode_step_0_layer_0");
});

test("Field-order independence — parser matches any key=value order", () => {
  // Reverse field order — must still parse correctly
  const stderr =
    "[full-model] shape=[1,768] finite=false kind=full_attention layer=23 segment=x bytes=0 elapsed_ms=0 handles=0 active_mem=N/A";

  const events = parseStandardLayerEvents(stderr, "run-3");
  expect(events.length).toBe(1);
  expect(events[0]!.stage).toMatchObject({
    layer_index: 23,
    attention_kind: "full_attention",
    status: "failed", // finite=false
  });
});

test("Non-matching lines are skipped silently", () => {
  const stderr = [
    "Compiling quantized Gemma 4 12B...",
    "Compiled in 2045.5s: 49 segments, 1180 tensors",
    "image hash: d042df1e4062a53e3a003af4e2e8c714924fcf19f03b7cf0dd5f67293355d924",
    "[phase] prefill start",
    "[full-model] layer=0 kind=sliding_attention shape=[1,3840] finite=true segment=M bytes=0 elapsed_ms=0 handles=0 active_mem=N/A",
    "[phase] prefill end",
  ].join("\n");

  const events = parseStandardLayerEvents(stderr, "run-4");
  expect(events.length).toBe(1);
  expect(events[0]!.stage.layer_index).toBe(0);
});

test("Eight decode passes get correct forward_pass_index", () => {
  // Simulate 1 prefill + 8 decode steps
  const lines = ["[phase] prefill start"];
  lines.push("[full-model] layer=0 kind=sliding_attention shape=[1,3840] finite=true segment=M bytes=0 elapsed_ms=0 handles=0 active_mem=N/A");
  lines.push("[phase] prefill end");
  for (let step = 0; step < 8; step++) {
    lines.push(`[phase] decode_step start token_step=${step}`);
    lines.push("[full-model] layer=0 kind=sliding_attention shape=[1,3840] finite=true segment=M bytes=0 elapsed_ms=0 handles=0 active_mem=N/A");
    lines.push("[phase] decode_step end");
  }

  const events = parseStandardLayerEvents(lines.join("\n"), "run-5");
  expect(events.length).toBe(9); // 1 prefill + 8 decode

  // Prefill: pass=1
  expect(events[0]!.stage.forward_pass_index).toBe(1);
  expect(events[0]!.stage.phase).toBe("prefill");

  // Decode steps: pass=2..9, step=0..7
  for (let s = 0; s < 8; s++) {
    expect(events[s + 1]!.stage.forward_pass_index).toBe(s + 2);
    expect(events[s + 1]!.stage.phase).toBe("decode_step");
    expect(events[s + 1]!.stage.token_step).toBe(s);
  }
});

test("V3 [proj] parser extracts all fields from a full projection line", () => {
  const stderr = [
    "[phase] prefill start",
    "[proj] run_id=test-run phase=prefill forward_pass=1 token_step=_- layer=12 kind=full family=q_proj invocation=3 graph_build_ns=48521 input=[1,64] weight_logical=[64,64] weight_physical=[64,64] storage_dtype=Uint8 runtime_dtype=Float32 group_size=32 bits=4 transpose=true",
    "[phase] prefill end",
  ].join("\n");

  const events = parseStandardLayerEvents(stderr, "run-v3-full");
  expect(events.length).toBe(1);
  expect(events[0]!.event_type).toBe("projection_stage");

  const s = events[0]!.stage;
  expect(s.layer_index).toBe(12);
  expect(s.attention_kind).toBe("full");
  expect(s.status).toBe("completed");
  expect(s.stage_id).toBe("prefill_layer_12_q_proj");

  const m = s.measurements;
  expect(m.grammar_version).toBe("v3");
  expect(m.projection_graph_build_ns).toBe(48521);
  expect(m.input_shape).toEqual([1, 64]);
  expect(m.weight_logical_shape).toEqual([64, 64]);
  expect(m.weight_physical_shape).toEqual([64, 64]);
  expect(m.storage_dtype).toBe("Uint8");
  expect(m.runtime_dtype).toBe("Float32");
  expect(m.group_size).toBe(32);
  expect(m.bits).toBe(4);
  expect(m.transpose).toBe(true);
});

test("V3 parser correctly sets event_type to projection_stage", () => {
  const stderr = [
    "[phase] prefill start",
    "[proj] run_id=r phase=prefill forward_pass=1 token_step=_- layer=0 kind=sliding family=k_proj invocation=0 graph_build_ns=1000 input=[1,64] weight_logical=[64,64] weight_physical=[64,64]",
    "[phase] prefill end",
  ].join("\n");

  const events = parseStandardLayerEvents(stderr, "run-v3-evtype");
  expect(events.length).toBe(1);
  expect(events[0]!.event_type).toBe("projection_stage");
});

test("V3 parser is backward-compatible (V1 and V2 lines still parse)", () => {
  // Mix V1, V2, and V3 lines in one stderr dump
  const stderr = [
    "[phase] prefill start",
    // V1 line
    "[full-model] layer=0 kind=sliding_attention shape=[1,3840] finite=true segment=M bytes=0 elapsed_ms=1800 handles=0 active_mem=N/A",
    // V2 line
    "[full-model] layer=5 kind=full_attention shape=[1,3840] finite=true segment=M bytes=0 graph_us=1200 eval_us=300 rss=1.2GB→1.3GB active=500MB→600MB cache=100MB→150MB kv_seq=4096 kv_copy=8192 kv_alloc=16384",
    // V3 line
    "[proj] run_id=r phase=prefill forward_pass=1 token_step=_- layer=12 kind=full family=o_proj invocation=0 graph_build_ns=48521 input=[1,64] weight_logical=[64,64] weight_physical=[64,64]",
    "[phase] prefill end",
  ].join("\n");

  const events = parseStandardLayerEvents(stderr, "run-v3-bc");
  // V1 (stage) + V2 (stage) + V2 (memory_sample) + V3 (projection_stage) = 4 events
  expect(events.length).toBe(4);

  // V1: stage event with grammar_version v1
  expect(events[0]!.event_type).toBe("stage");
  expect(events[0]!.stage.layer_index).toBe(0);
  expect(events[0]!.stage.measurements.grammar_version).toBe("v1");

  // V2: memory_sample event (generated because V2 line has rss/active/cache)
  expect(events[1]!.event_type).toBe("memory_sample");

  // V2: stage event with grammar_version v2
  expect(events[2]!.event_type).toBe("stage");
  expect(events[2]!.stage.layer_index).toBe(5);
  expect(events[2]!.stage.measurements.grammar_version).toBe("v2");

  // V3: projection_stage event with grammar_version v3
  expect(events[3]!.event_type).toBe("projection_stage");
  expect(events[3]!.stage.layer_index).toBe(12);
  expect(events[3]!.stage.measurements.grammar_version).toBe("v3");
});

test("V3 parser omits absent measurements (no phantom zeros)", () => {
  // Minimal V3 line — only required fields, no optional fields
  const stderr = [
    "[phase] prefill start",
    "[proj] run_id=r phase=prefill forward_pass=1 token_step=_- layer=7 kind=full family=v_proj invocation=2 graph_build_ns=12345 input=[1,128] weight_logical=[128,256] weight_physical=[128,256]",
    "[phase] prefill end",
  ].join("\n");

  const events = parseStandardLayerEvents(stderr, "run-v3-omit");
  expect(events.length).toBe(1);

  const m = events[0]!.stage.measurements;
  // Present fields
  expect(m.grammar_version).toBe("v3");
  expect(m.projection_graph_build_ns).toBe(12345);
  expect(m.input_shape).toEqual([1, 128]);
  expect(m.weight_logical_shape).toEqual([128, 256]);
  expect(m.weight_physical_shape).toEqual([128, 256]);

  // Absent fields are UNDEFINED (not zero/null)
  expect(m.storage_dtype).toBeUndefined();
  expect(m.runtime_dtype).toBeUndefined();
  expect(m.group_size).toBeUndefined();
  expect(m.bits).toBeUndefined();
  expect(m.transpose).toBeUndefined();
});

test("V3 stage ID format is correct", () => {
  // Prefill stage ID
  const prefillStderr = [
    "[phase] prefill start",
    "[proj] run_id=r phase=prefill forward_pass=1 token_step=_- layer=3 kind=sliding family=gate_proj invocation=0 graph_build_ns=500 input=[1,64] weight_logical=[64,64] weight_physical=[64,64]",
    "[phase] prefill end",
  ].join("\n");
  const prefillEvents = parseStandardLayerEvents(prefillStderr, "run-v3-sid");
  expect(prefillEvents[0]!.stage.stage_id).toBe("prefill_layer_3_gate_proj");

  // Decode stage ID
  const decodeStderr = [
    "[phase] decode_step start token_step=0",
    "[proj] run_id=r phase=decode_step forward_pass=2 token_step=0 layer=12 kind=full family=up_proj invocation=1 graph_build_ns=3000 input=[1,128] weight_logical=[128,3840] weight_physical=[128,3840]",
    "[phase] decode_step end",
  ].join("\n");
  const decodeEvents = parseStandardLayerEvents(decodeStderr, "run-v3-sid");
  expect(decodeEvents.length).toBe(1);
  expect(decodeEvents[0]!.stage.stage_id).toBe("decode_step_0_layer_12_up_proj");
});
