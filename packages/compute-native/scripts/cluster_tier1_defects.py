#!/usr/bin/env python3
"""Cluster the 13 Tier 1 non-pass rows by root cause.

Reads receipts from the completed TIER1-GATE run, assigns each to a cluster via
the rules below, and writes a markdown triage table to local://tier1-defect-clusters.md.

Cluster assignment rules (evaluated in order):
  1. terminal_phase == "mil_build" AND backend == "coreml"  → A: coreml-mil-shape
  2. terminal_phase == "predict" AND predict_status == "predict_blocked"  → B: coreml-predict-runtime
  3. failure_reason contains "cannot be broadcast" AND backend == "mlx"  → C: mlx-broadcast-reject
  4. max_absolute_error == float("inf") or max_absolute_error == 1.7976931348623157e+308  → D1: count-mismatch
  5. max_absolute_error < 1e300 AND matches_tolerance == false  → D2: numerical-divergence
  6. otherwise → unclassified
"""

import json
import os
import math

BASE_DIR = os.path.join(
    os.path.dirname(__file__),
    "..",
    "decode_attribution_runs",
    "TIER1-GATE",
    "DA-0001-193461",
)

NON_PASS_ROWS = [
    ("coreml", "add_standalone", "small"),
    ("coreml", "add_standalone", "medium"),
    ("coreml", "mul_standalone", "small"),
    ("coreml", "mul_standalone", "medium"),
    ("coreml", "sigmoid_standalone", "small"),
    ("coreml", "sigmoid_standalone", "medium"),
    ("coreml", "silu_standalone", "small"),
    ("coreml", "silu_standalone", "medium"),
    ("mlx", "add_standalone", "medium"),
    ("mlx", "mul_standalone", "small"),
    ("mlx", "mul_standalone", "medium"),
    ("accelerate", "add_standalone", "small"),
    ("accelerate", "mul_standalone", "medium"),
]


F64_MAX = 1.7976931348623157e308


def classify(receipt: dict) -> tuple[str, str]:
    """Return (cluster_label, next_action)."""
    backend = receipt.get("backend", "")
    terminal_phase = receipt.get("terminal_phase", "")
    predict_status = receipt.get("predict_status", "")
    failure_reason = receipt.get("failure_reason", "") or ""
    max_abs_err = receipt.get("max_absolute_error", 0.0)
    matches_tol = receipt.get("matches_tolerance", False)

    # Rule 1: Core ML MIL shape error
    if terminal_phase == "mil_build" and backend == "coreml":
        return "A: coreml-mil-shape", "fix graph catalog builder shapes"

    # Rule 2: Core ML predict runtime error (compiles but fails at predict)
    if terminal_phase == "predict" and predict_status == "predict_blocked":
        return "B: coreml-predict-runtime", "investigate Core ML runtime -20 (os version?)"

    # Rule 3: MLX broadcast rejection
    if "cannot be broadcast" in failure_reason and backend == "mlx":
        return "C: mlx-broadcast-reject", "fix graph catalog shapes or adapter reshape"

    # Rule 4: element-count mismatch (f64::MAX sentinel from conformance.rs)
    if max_abs_err == F64_MAX or (isinstance(max_abs_err, float) and math.isinf(max_abs_err)):
        return "D1: count-mismatch", "unify broadcasting between reference adapter and backends"

    # Rule 5: real numerical divergence
    if max_abs_err < 1e300 and not matches_tol:
        return "D2: numerical-divergence", "investigate weight seed / vDSP precision"

    return "unclassified", "manual inspection"


def extract_fields(receipt: dict) -> dict:
    """Pull the required display fields from a receipt."""
    ep = receipt.get("execution_proof", {}) or {}
    return {
        "backend": receipt.get("backend", ""),
        "family": receipt.get("graph_family", ""),
        "shape": receipt.get("shape_profile", ""),
        "status": receipt.get("status", ""),
        "terminal_phase": receipt.get("terminal_phase", ""),
        "predict_status": receipt.get("predict_status", ""),
        "backend_support_status": receipt.get("backend_support_status", ""),
        "execution_kind": receipt.get("execution_kind", ""),
        "accelerated_ops": ", ".join(ep.get("accelerated_ops", []) or []),
        "vdsp_ops": ", ".join(ep.get("accelerate_vdsp_ops", []) or []),
        "blas_ops": ", ".join(ep.get("accelerate_blas_ops", []) or []),
        "max_absolute_error": receipt.get("max_absolute_error", 0.0),
        "cosine_similarity": receipt.get("cosine_similarity", 0.0),
        "matches_tolerance": receipt.get("matches_tolerance", False),
        "ref_hash": (receipt.get("reference_output_hashes") or [""])[0],
        "failure_reason": receipt.get("failure_reason", ""),
        "failure_diagnostics": receipt.get("failure_diagnostics", ""),
    }


def fmt_err(val: float) -> str:
    """Format error value for display."""
    if val == F64_MAX or (isinstance(val, float) and val > 1e100):
        return "∞"
    if val == 0.0:
        return "0.0"
    return f"{val:.4f}"


def fmt_cos(val: float) -> str:
    """Format cosine similarity."""
    if val >= 0.9999:
        return "1.0"
    return f"{val:.4f}"


def main():
    print("Extracting non-pass receipts from", BASE_DIR)

    cluster_counts: dict[str, int] = {}
    table_rows = []

    for backend, family, shape in NON_PASS_ROWS:
        path = os.path.join(BASE_DIR, backend, family, shape, "receipt.json")
        print(f"  {backend}/{family}/{shape} ... ", end="", flush=True)

        if not os.path.exists(path):
            print(f"NOT FOUND: {path}")
            # Add unclassified row
            table_rows.append({
                "backend": backend,
                "family": family,
                "shape": shape,
                "status": "missing",
                "terminal_phase": "",
                "cluster": "unclassified",
                "next_action": "rerun suite (receipt missing)",
            })
            cluster_counts["unclassified"] = cluster_counts.get("unclassified", 0) + 1
            continue

        with open(path) as f:
            receipt = json.load(f)

        fields = extract_fields(receipt)
        cluster, action = classify(receipt)
        cluster_counts[cluster] = cluster_counts.get(cluster, 0) + 1

        max_err_str = fmt_err(fields["max_absolute_error"])
        cos_str = fmt_cos(fields["cosine_similarity"])
        ref_hash = fields["ref_hash"][:8] + ".." if len(fields["ref_hash"]) > 8 else fields["ref_hash"]

        # Build execution proof summary
        exec_ops = fields["accelerated_ops"]
        if fields["vdsp_ops"]:
            exec_ops = exec_ops + (" + vDSP: " + fields["vdsp_ops"]) if exec_ops else "vDSP: " + fields["vdsp_ops"]
        if not exec_ops:
            exec_ops = "-"

        table_rows.append({
            "backend": backend,
            "family": family,
            "shape": shape,
            "status": fields["status"],
            "terminal_phase": fields["terminal_phase"],
            "max_abs_err": max_err_str,
            "cos_sim": cos_str,
            "ref_hash": ref_hash,
            "exec_kind": fields["execution_kind"],
            "exec_ops": exec_ops,
            "cluster": cluster,
            "next_action": action,
        })
        print(cluster)

    # ── Write output ──────────────────────────────────────────────────────
    lines = []
    lines.append("# Tier 1 Defect Clustering — DA-0001-193461")
    lines.append("")
    lines.append(f"Total non-pass Tier 1 rows: {len(table_rows)}")
    lines.append("")
    lines.append("## Cluster summary")
    lines.append("")
    lines.append("| Cluster | Count | Description |")
    lines.append("|---------|-------|-------------|")
    for cl in ["A: coreml-mil-shape", "B: coreml-predict-runtime", "C: mlx-broadcast-reject",
               "D1: count-mismatch", "D2: numerical-divergence"]:
        cnt = cluster_counts.get(cl, 0)
        desc = {
            "A: coreml-mil-shape": "Core ML MIL shape-contract failure (incompatible broadcast dims)",
            "B: coreml-predict-runtime": "Core ML predict returns error -20 (compiles but fails at predict)",
            "C: mlx-broadcast-reject": "MLX broadcasting rejects shape pair",
            "D1: count-mismatch": "Backend/reference output element count differs",
            "D2: numerical-divergence": "Real numerical mismatch (same lengths, different values)",
        }.get(cl, "")
        if cnt > 0:
            lines.append(f"| {cl:35s} | {cnt:5d} | {desc} |")
    lines.append("")

    # Triage table
    lines.append("## Triage table")
    lines.append("")
    header = "| backend | family | shape | status | terminal_phase | max_abs_err | cos_sim | exec_kind | exec_ops | cluster | next_action |"
    sep = "|---------|--------|-------|--------|----------------|-------------|---------|-----------|----------|---------|-------------|"
    lines.append(header)
    lines.append(sep)
    for row in table_rows:
        lines.append(
            f"| {row['backend']:10s} | {row['family']:20s} | {row['shape']:6s}"
            f" | {row['status']:22s} | {row['terminal_phase']:15s}"
            f" | {row['max_abs_err']:>11s} | {row['cos_sim']:>7s}"
            f" | {row['exec_kind']:22s} | {row['exec_ops']:20s}"
            f" | {row['cluster']:25s} | {row['next_action']} |"
        )
    lines.append("")

    # Recommendation
    lines.append("## Recommended next gate")
    lines.append("")
    lines.append("**FIX-COREML-STANDALONE-SHAPES** — Fix the graph catalog builders for")
    lines.append("`add_standalone`, `mul_standalone`, and `silu_standalone` to produce")
    lines.append("broadcast-compatible MIL shapes.")
    lines.append("")
    lines.append("Rationale:")
    lines.append("- Highest leverage: fixes cluster A (6 rows) and may cascade to fix")
    lines.append("  cluster C (2 rows) = up to 8 rows recovered")
    lines.append("- Lowest risk: only affects Tier 1 families that currently fail")
    lines.append("- Root cause is well-understood (MIL shape-contract violation) and")
    lines.append("  manifests identically across 6 receipts")

    output = "\n".join(lines) + "\n"
    output_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "local", "tier1-defect-clusters.md")
    # If /local/ doesn't exist under standard paths, write to cwd
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        f.write(output)

    print(f"\nOutput written to {output_path}")
    print(f"\nCluster breakdown:")
    for cl in sorted(cluster_counts.keys()):
        print(f"  {cl:35s}: {cluster_counts[cl]:3d}")


if __name__ == "__main__":
    main()
