#!/usr/bin/env python3
"""Compile a Core ML region from a MIL program definition."""
import sys, os, json, subprocess

def compile_mlprogram(prog, output_name, compute_units="cpuAndGPU", deployment_target="macOS15"):
    import coremltools as ct

    mlmodel = ct.convert(
        prog,
        convert_to="mlprogram",
        minimum_deployment_target=getattr(ct.target, deployment_target),
        compute_units=ct.ComputeUnit.CPU_AND_GPU,
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

    print(f"COMPILE: {output_name} -> {mlmodelc_path}")
    return mlmodelc_path
