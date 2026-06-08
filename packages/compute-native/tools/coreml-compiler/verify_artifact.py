#!/usr/bin/env python3
"""Verify a compiled .mlmodelc artifact (metadata, MIL, nonzero data)."""
import sys, os, json

def verify_mlmodelc(path):
    """Verify that a .mlmodelc directory is loadable. Returns (pass, metadata)."""
    if not os.path.isdir(path):
        return False, f"path does not exist: {path}"

    # coremlcompiler creates a nested directory: {path}/{basename}/
    # Walk to find the actual model directory containing metadata.json
    model_dir = None
    for root, dirs, files in os.walk(path):
        if "metadata.json" in files:
            model_dir = root
            break
    if model_dir is None:
        return False, f"no metadata.json found in {path} (compiled output may be nested)"

    metadata_path = os.path.join(model_dir, "metadata.json")

    # model.mil expected in the same directory as metadata.json
    if not os.path.exists(os.path.join(model_dir, "model.mil")):
        return False, f"no model.mil in {model_dir}"

    # Check for nonzero data files (skip metadata.json itself)
    has_data = False
    for root, dirs, files in os.walk(model_dir):
        for f in files:
            fpath = os.path.join(root, f)
            if os.path.getsize(fpath) > 0 and f != "metadata.json":
                has_data = True
                break
    if not has_data:
        return False, f"no nonzero data files in {model_dir} (empty artifact)"

    with open(metadata_path) as f:
        meta = json.load(f)

    return True, {
        "path": path,
        "model_dir": model_dir,
        "state_schema": meta[0].get("stateSchema", []),
        "input_schema": meta[0].get("inputSchema", []),
        "output_schema": meta[0].get("outputSchema", []),
        "macos_version": meta[0].get("availability", {}).get("macOS", "unknown"),
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <path/to/model.mlmodelc>", file=sys.stderr)
        sys.exit(1)
    ok, info = verify_mlmodelc(sys.argv[1])
    if ok:
        print("VERIFY: PASS")
        print(json.dumps(info, indent=2))
    else:
        print(f"VERIFY: FAIL — {info}", file=sys.stderr)
        sys.exit(1)
