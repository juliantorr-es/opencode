#!/bin/bash
# Mission 0007: Interleaved experimental runs with page cache warming
set -euo pipefail

ARM="${1:-A}"
RUN_ID="${2:-1}"
IMAGE="/tmp/tribunus-image-d042df1e"
BIN="/Users/user/Developer/GitHub/Tribunus/packages/compute-native/target/image-build/tribunus-compute-image"
ENV="TRIBUNUS_COMPILED_IMAGE=$IMAGE TRIBUNUS_COMPUTE_ALLOW_HIGH_MEMORY=1 TRIBUNUS_SKIP_MANIFEST_HASH=1"

echo "=== M7 $(date -u +%Y-%m-%dT%H:%M:%SZ) arm=$ARM run=$RUN_ID ==="

# Pipeline conditioning (Arms B, D)
if [ "$ARM" = "B" ] || [ "$ARM" = "D" ]; then
  COND_START=$(python3 -c 'import time; print(int(time.time()*1e9))')
  echo "[conditioning] Pipeline warm-up (3 projection families)..."
  for FAMILY in q_proj gate_proj down_proj; do
    env $ENV $BIN replay-projection \
      --image "$IMAGE" --layer 0 --family "$FAMILY" \
      --phase-shape decode --samples 1 --warmups 0 \
      2>/dev/null >/dev/null
  done
  COND_END=$(python3 -c 'import time; print(int(time.time()*1e9))')
  COND_MS=$(( (COND_END - COND_START) / 1000000 ))
  echo "{\"arm\":\"$ARM\",\"run\":\"$RUN_ID\",\"phase\":\"conditioning\",\"duration_ms\":$COND_MS}"
fi

# Page cache prefetch (Arms C, D): warm upcoming segment files in background
PF_PID=""
if [ "$ARM" = "C" ] || [ "$ARM" = "D" ]; then
  PF_START=$(python3 -c 'import time; print(int(time.time()*1e9))')
  echo "[prefetch] Warming page cache for all segments..."
  # Force all segments into page cache via readahead
  find "$IMAGE" -name "segment_*.bin" -exec cat {} > /dev/null \; &
  PF_PID=$!
  disown $PF_PID
  PF_END=$(python3 -c 'import time; print(int(time.time()*1e9))')
  PF_MS=$(( (PF_END - PF_START) / 1000000 ))
  echo "{\"arm\":\"$ARM\",\"run\":\"$RUN_ID\",\"phase\":\"prefetch_launched\",\"duration_ms\":$PF_MS}"
fi

# Inference
START=$(python3 -c 'import time; print(int(time.time()*1e9))')
env $ENV $BIN decode-one --image "$IMAGE" --layout-policy frozen_existing --arm "$ARM" 2>&1 \
  | grep '"decode_s"\|"prefill_s"\|"status"\|"json"' | tail -3
END=$(python3 -c 'import time; print(int(time.time()*1e9))')
WALL_MS=$(( (END - START) / 1000000 ))

# Wait for prefetch to finish if active
if [ -n "$PF_PID" ]; then
  wait $PF_PID 2>/dev/null || true
  echo "{\"arm\":\"$ARM\",\"run\":\"$RUN_ID\",\"phase\":\"prefetch_complete\"}"
fi

echo "{\"arm\":\"$ARM\",\"run\":\"$RUN_ID\",\"wall_ms\":$WALL_MS}"
