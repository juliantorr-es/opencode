#!/usr/bin/env python3
"""Core ML compiler preflight — fail-closed qualification."""
import importlib.util
import platform
import sys
import os
import json
import subprocess

def probe_native_modules():
    required = ["coremltools.libcoremlpython", "coremltools.libmilstoragepython"]
    for m in required:
        spec = importlib.util.find_spec(m)
        if spec is None:
            raise SystemExit(f"PREFLIGHT FAIL: {m} missing")
    print(f"PREFLIGHT: native modules present")

def probe_environment():
    import coremltools as ct
    env = {
        "python_version": sys.version.split()[0],
        "python_abi": f"cp{sys.version_info.major}{sys.version_info.minor}",
        "architecture": platform.machine(),
        "coremltools_version": ct.__version__,
        "coremltools_path": ct.__file__,
        "macos_version": platform.mac_ver()[0],
    }
    for k, v in env.items():
        print(f"PREFLIGHT: {k} = {v}")
    if env["architecture"] != "arm64":
        raise SystemExit(f"PREFLIGHT FAIL: architecture is {env['architecture']}, need arm64")
    return env

def probe_tiny_model():
    """Compile a tiny ML Program with one constant weight, prove it loads."""
    import coremltools as ct
    from coremltools.converters.mil import Builder as mb
    from coremltools.converters.mil.mil import types
    import numpy as np
    import tempfile

    # Build a tiny program: input x[1,2] fp16, output x * weight[2]
    @mb.program(input_specs=[mb.TensorSpec(shape=(1, 2), dtype=types.fp16)])
    def probe_prog(x):
        w = mb.const(val=np.array([1.0, 2.0], dtype=np.float16), name="weight")
        return mb.mul(x=x, y=w, name="output")

    tmpdir = tempfile.mkdtemp(prefix="coreml-preflight-")
    mlpackage_path = os.path.join(tmpdir, "probe.mlpackage")

    # Convert to mlpackage
    mlmodel = ct.convert(
        probe_prog,
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS15,
        compute_units=ct.ComputeUnit.CPU_AND_GPU,
    )
    mlmodel.save(mlpackage_path)

    # Verify nonzero weight blob in mlpackage
    data_dir = os.path.join(mlpackage_path, "Data")
    has_data = False
    for root, dirs, files in os.walk(data_dir):
        for f in files:
            fpath = os.path.join(root, f)
            if os.path.getsize(fpath) > 0:
                has_data = True
                print(f"PREFLIGHT: nonzero data: {fpath} ({os.path.getsize(fpath)} bytes)")
    if not has_data:
        raise SystemExit("PREFLIGHT FAIL: no nonzero weight data in mlpackage")

    # Compile with xcrun — coremlcompiler creates {mlmodelc_path}/{basename}/
    mlmodelc_path = os.path.join(tmpdir, "probe.mlmodelc")
    result = subprocess.run(
        ["xcrun", "coremlcompiler", "compile", mlpackage_path, mlmodelc_path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise SystemExit(f"PREFLIGHT FAIL: coremlcompiler failed: {result.stderr}")

    # Walk compiled output to find actual model directory
    compiled_model_dir = None
    for root, dirs, files in os.walk(mlmodelc_path):
        if "metadata.json" in files:
            compiled_model_dir = root
            break
    if compiled_model_dir is None:
        raise SystemExit(f"PREFLIGHT FAIL: no metadata.json in compiled output at {mlmodelc_path}")

    # Verify model.mil present
    model_mil = os.path.join(compiled_model_dir, "model.mil")
    if not os.path.exists(model_mil):
        raise SystemExit(f"PREFLIGHT FAIL: no model.mil in compiled output at {compiled_model_dir}")

    # Verify nonzero data in compiled output
    has_data = False
    for root, dirs, files in os.walk(compiled_model_dir):
        for f in files:
            fpath = os.path.join(root, f)
            if os.path.getsize(fpath) > 0 and f != "metadata.json":
                has_data = True
                print(f"PREFLIGHT: compiled nonzero data: {fpath} ({os.path.getsize(fpath)} bytes)")
    if not has_data:
        raise SystemExit("PREFLIGHT FAIL: compiled output has no nonzero data")

    print(f"PREFLIGHT: compiled to {mlmodelc_path}")
    print("PREFLIGHT: PASS — full compiler pipeline verified")
    return compiled_model_dir

if __name__ == "__main__":
    print("=== Core ML Compiler Preflight ===")
    env = probe_environment()
    probe_native_modules()
    model_path = probe_tiny_model()

    receipt = {**env, "preflight_model": model_path, "status": "PASS"}
    with open("environment.json", "w") as f:
        json.dump(receipt, f, indent=2)
    print(f"\nEnvironment receipt written to environment.json")
