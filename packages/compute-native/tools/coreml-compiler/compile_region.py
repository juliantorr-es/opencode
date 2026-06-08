#!/usr/bin/env python3
"""Compile a Core ML region from a MIL program definition."""
import sys, os, json, subprocess

def compile_mlprogram(prog, output_name, compute_units="cpuAndGPU", deployment_target="macOS15"):
    import coremltools as ct

    mlmodel = ct.convert(
        prog,
        convert_to="mlprogram",
        minimum_deployment_target=getattr(ct.target, deployment_target),
        compute_precision=ct.precision.FLOAT16,
        compute_units=getattr(ct.ComputeUnit, compute_units),
    )

    mlpackage_path = f"/tmp/tribunus-{output_name}.mlpackage"
    mlmodel.save(mlpackage_path)

    mlmodelc_path = f"/tmp/tribunus-{output_name}.mlmodelc"
    result = subprocess.run(
        ["xcrun", "coremlcompiler", "compile", mlpackage_path, mlmodelc_path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"COMPILE FAIL: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    # coremlcompiler nests output: outer/name.mlmodelc/
    # Core ML APIs expect the inner directory containing metadata.json.
    inner_path = _find_model_dir(mlmodelc_path)
    if inner_path is None:
        print(f"COMPILE FAIL: no metadata.json in {mlmodelc_path}", file=sys.stderr)
        sys.exit(1)
    print(f"COMPILE: {output_name} -> {inner_path}")
    return inner_path


def _find_model_dir(mlmodelc_path):
    """Walk compiled output to find the inner directory with metadata.json."""
    for root, dirs, files in os.walk(mlmodelc_path):
        if "metadata.json" in files and "model.mil" in files:
            return root
    return None
