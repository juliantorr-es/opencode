#!/bin/bash
# Mission 0007: Interleaved experimental runs
# Usage: ./mission0007-experiment.sh <arm> <run-id>
# Arms: A (control), B (pipeline warm), C (prefetch), D (combined), E (sham)
set -euo pipefail

ARM="${1:-A}"
RUN_ID="${2:-1}"
IMAGE="/tmp/tribunus-image-d042df1e"
BIN="/Users/user/Developer/GitHub/Tribunus/packages/compute-native/target/image-build/tribunus-compute-image"
ENV="TRIBUNUS_COMPILED_IMAGE=$IMAGE TRIBUNUS_COMPUTE_ALLOW_HIGH_MEMORY=1 TRIBUNUS_SKIP_MANIFEST_HASH=1 METAL_CAPTURE_ENABLED=0"

echo "=== M7 $(date -u +%Y-%m-%dT%H:%M:%SZ) arm=$ARM run=$RUN_ID ==="

# Pipeline conditioning (Arms B, D): warm up first-layer projections
if [ "$ARM" = "B" ] || [ "$ARM" = "D" ]; then
  COND_START=$(gdate +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
  echo "[conditioning] Running pipeline warm-up..."
  for FAMILY in q_proj gate_proj down_proj; do
    env $ENV $BIN replay-projection \
      --image "$IMAGE" --layer 0 --family "$FAMILY" \
      --phase-shape decode --samples 1 --warmups 0 \
      2>/dev/null >/dev/null
  done
  COND_END=$(gdate +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
  COND_MS=$(( (COND_END - COND_START) / 1000000 ))
  echo "[conditioning] Complete in ${COND_MS}ms"
  echo "{\"arm\":\"$ARM\",\"run\":\"$RUN_ID\",\"phase\":\"conditioning\",\"duration_ms\":$COND_MS}"
fi

# Inference
START=$(gdate +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
env $ENV $BIN decode-one --image "$IMAGE" --layout-policy frozen_existing --arm "$ARM" 2>&1 \
  | grep '"decode_s"\|"prefill_s"\|"status"'
END=$(gdate +%s%N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1e9))')
WALL_MS=$(( (END - START) / 1000000 ))
echo "{\"arm\":\"$ARM\",\"run\":\"$RUN_ID\",\"wall_ms\":$WALL_MS}"
