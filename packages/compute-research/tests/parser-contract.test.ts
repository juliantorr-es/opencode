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
