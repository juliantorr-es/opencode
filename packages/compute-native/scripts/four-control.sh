#!/usr/bin/env bash
# Mission 0006A — Four-control experiment: pipeline vs page residency
# Control A: Repeated mapped q_proj cold→warm (baseline)
# Control B: Pipeline warm with owned synthetic, then test mapped
# Control C: Pre-touch mapped pages on CPU, then test mapped
# Control D: Layer-to-layer specificity (warm layer 12 → test layer 13)

set -e

BIN="/Users/user/Developer/GitHub/Tribunus/packages/compute-native/target/image-build/tribunus-compute-image"
IMAGE="/Users/user/Developer/TribunusModels/compute-images/d042df1e4062a53e3a003af4e2e8c714924fcf19f03b7cf0dd5f67293355d924"
export TRIBUNUS_COMPILED_IMAGE="$IMAGE"
export TRIBUNUS_COMPUTE_ALLOW_HIGH_MEMORY=1

echo "=== Control A: Repeated mapped q_proj (layer 12, decode) ==="
echo "Cold + 5 warm samples"
$BIN replay-projection --image "$IMAGE" --layer 12 --family q_proj --phase-shape decode --samples 5 --warmups 0 2>/dev/null | while read line; do
    echo "$line" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'{d[\"phase\"]:>20} eval={d[\"forced_eval_ns\"]/1e6:.3f}ms graph={d[\"graph_build_ns\"]/1e6:.3f}ms')"
done

echo ""
echo "=== Control D: Layer specificity (warm layer 12 → test layer 13 q_proj) ==="
echo "--- Layer 12 warm (3 samples) ---"
$BIN replay-projection --image "$IMAGE" --layer 12 --family q_proj --phase-shape decode --samples 3 --warmups 0 2>/dev/null | while read line; do
    echo "$line" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'L12 {d[\"phase\"]:>20} eval={d[\"forced_eval_ns\"]/1e6:.3f}ms')"
done
echo "--- Layer 13 first call ---"
$BIN replay-projection --image "$IMAGE" --layer 13 --family q_proj --phase-shape decode --samples 1 --warmups 0 2>/dev/null | while read line; do
    echo "$line" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'L13 {d[\"phase\"]:>20} eval={d[\"forced_eval_ns\"]/1e6:.3f}ms')"
done

echo ""
echo "=== Control C: Pre-touch pages (layer 14 q_proj, decode) ==="
# First run cold
echo "--- Cold (layer 14) ---"
$BIN replay-projection --image "$IMAGE" --layer 14 --family q_proj --phase-shape decode --samples 1 --warmups 0 2>/dev/null | while read line; do
    echo "$line" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'cold eval={d[\"forced_eval_ns\"]/1e6:.3f}ms')"
done
# Now run again (same process, pretouched by previous run)
echo "--- Warmed by prior run (layer 14 again) ---"
$BIN replay-projection --image "$IMAGE" --layer 14 --family q_proj --phase-shape decode --samples 1 --warmups 0 2>/dev/null | while read line; do
    echo "$line" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'pretouched eval={d[\"forced_eval_ns\"]/1e6:.3f}ms')"
done