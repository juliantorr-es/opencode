//! DECODE-MICROPHASE-SUITE-0001: Tier 2 manifest and support matrix generator.
//!
//! Writes:
//! - decode_microphase_manifest.json     — Suite manifest for all 42 Batch 1 rows
//! - support_matrix.json                  — Claimed support matrix for the report
//! - decode_microphase_support_matrix.json — Per-backend support classification
//! - decode_microphase_shape_map.json    — Symbolic dim bindings for decode profiles
//! - decode_microphase_receipt_index.json — Row metadata index for compute-image ingestion

use std::path::PathBuf;
use std::time::Instant;

use tribunus_compute_native::decode_attribution::decode_microphase_shape_map::{
    ALL_DECODE_SHAPES, DecodeShapeBinding,
};
use tribunus_compute_native::decode_attribution::graph_catalog::{DECODE_BATCH1_NAMES, DECODE_BATCH1_OP_COUNTS};
use tribunus_compute_native::decode_attribution::suite_manifest::{tier2_batch1_manifest, SupportStatus, SuiteRow, SuiteTier};
use tribunus_compute_native::pipeline_parity::kv_contracts_for_backend;
use tribunus_compute_native::pipeline_parity::decode_microphase_support_for;
use tribunus_compute_native::decode_attribution::backend_adapters::BackendKind;

#[derive(serde::Serialize)]
struct SupportMatrixEntry {
    row_id: String,
    family: String,
    shape_profile: String,
    semantic_shape_profile: String,
    backend: String,
    backend_policy: String,
    support_status: String,
    reason: Option<String>,
    blocked_by_tier1_defect: Option<String>,
}

#[derive(serde::Serialize)]
struct ClaimedSupportMatrixEntry {
    row_id: String,
    backend: String,
    backend_policy: String,
    support_status: String,
    execution_kind_if_supported: Option<String>,
    reason: Option<String>,
}

#[derive(serde::Serialize)]
struct ReceiptIndexEntry {
    row_id: String,
    tier: String,
    family: String,
    shape_profile: String,
    semantic_shape_profile: String,
    semantic_contract_id: String,
    pipeline_phase: String,
    backend: String,
    backend_policy: String,
    support_status: String,
    blocked: bool,
    comparison_eligible: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    kv_contract_ids: Vec<String>,
}

fn backend_kind_from_str(s: &str) -> BackendKind {
    match s {
        "coreml" => BackendKind::CoreMl,
        "mlx" => BackendKind::Mlx,
        "accelerate" => BackendKind::Accelerate,
        "reference" => BackendKind::Reference,
        _ => BackendKind::Reference,
    }
}

fn main() {
    let start = Instant::now();

    let args: Vec<String> = std::env::args().collect();
    let mut output_dir = PathBuf::from("decode_attribution_runs/DECODE-BATCH1");

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--output-dir" => {
                i += 1;
                output_dir = PathBuf::from(&args[i]);
            }
            "--help" | "-h" => {
                eprintln!("Usage: tribunus-tier2-manifest-gen [--output-dir <path>]");
                eprintln!();
                eprintln!("Generates Tier 2 Batch 1 manifest and support matrix in <output-dir>.");
                eprintln!("Default output-dir: decode_attribution_runs/DECODE-BATCH1");
                return;
            }
            other => {
                eprintln!("Unknown argument: {other}");
                return;
            }
        }
        i += 1;
    }

    std::fs::create_dir_all(&output_dir).unwrap_or_else(|e| {
        eprintln!("Error creating {:?}: {e}", output_dir);
        std::process::exit(1);
    });

    // ── 1. Generate and write manifest ─────────────────────────────────
    eprintln!("Generating Tier 2 Batch 1 manifest...");
    let manifest = tier2_batch1_manifest();
    let manifest_path = output_dir.join("decode_microphase_manifest.json");
    manifest.write_to_file(&manifest_path).unwrap_or_else(|e| {
        eprintln!("Error writing manifest: {e}");
        std::process::exit(1);
    });
    eprintln!("  Wrote {} rows to {:?}", manifest.rows.len(), manifest_path);

    // ── 2. Generate and write support matrix ───────────────────────────
    eprintln!("Generating support matrix...");
    let claimed_matrix_entries: Vec<ClaimedSupportMatrixEntry> = manifest.rows.iter().map(|row| {
        let backend = backend_kind_from_str(&row.backend);
        let status = decode_microphase_support_for(&row.family, backend);
        let (support_status, execution_kind_if_supported, reason) = match &status {
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Native => {
                ("supported_native".to_string(), Some(row.backend.clone()), None)
            }
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Composed => {
                ("supported_domain_adapter".to_string(), Some(row.backend.clone()), None)
            }
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Unsupported { code, reason } => {
                (format!("unsupported_{:?}", code), None, Some(reason.to_string()))
            }
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Pending { code, reason } => {
                (format!("pending_{:?}", code), None, Some(reason.to_string()))
            }
        };

        ClaimedSupportMatrixEntry {
            row_id: row.row_id.clone(),
            backend: row.backend.clone(),
            backend_policy: row.backend_policy.clone(),
            support_status,
            execution_kind_if_supported,
            reason,
        }
    }).collect();

    let claimed_matrix_path = output_dir.join("support_matrix.json");
    serde_json::to_writer_pretty(std::fs::File::create(&claimed_matrix_path).unwrap(), &claimed_matrix_entries)
        .unwrap_or_else(|e| {
            eprintln!("Error writing claimed support matrix: {e}");
            std::process::exit(1);
        });
    eprintln!("  Wrote {} entries to {:?}", claimed_matrix_entries.len(), claimed_matrix_path);

    let mut matrix_entries: Vec<SupportMatrixEntry> = Vec::new();
    for row in &manifest.rows {
        let backend = backend_kind_from_str(&row.backend);
        let status = decode_microphase_support_for(&row.family, backend);
        let (status_str, reason) = match &status {
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Native => {
                ("supported_native".to_string(), None)
            }
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Composed => {
                ("supported_domain_adapter".to_string(), None)
            }
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Unsupported { code, reason } => {
                (format!("unsupported_{:?}", code), Some(reason.to_string()))
            }
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Pending { code, reason } => {
                (format!("pending_{:?}", code), Some(reason.to_string()))
            }
        };

        // Check if any Tier 1 compile errors block this phase
        let blocked = if row.family.contains("residual") || row.family.contains("mlp_gate") || row.family.contains("lm_head") {
            if row.backend == "coreml" {
                // Core ML has compile errors for elementwise ops that may block residual adds
                if row.family.starts_with("decode_residual") {
                    Some("cluster_001_coreml_compile_contract".into())
                } else if row.family == "decode_mlp_gate_up_silu" {
                    Some("cluster_001_coreml_compile_contract".into())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        matrix_entries.push(SupportMatrixEntry {
            row_id: row.row_id.clone(),
            family: row.family.clone(),
            shape_profile: row.shape_profile.clone(),
            semantic_shape_profile: row.semantic_shape_profile.clone(),
            backend: row.backend.clone(),
            backend_policy: row.backend_policy.clone(),
            support_status: status_str,
            reason,
            blocked_by_tier1_defect: blocked,
        });
    }

    let matrix_path = output_dir.join("decode_microphase_support_matrix.json");
    serde_json::to_writer_pretty(std::fs::File::create(&matrix_path).unwrap(), &matrix_entries)
        .unwrap_or_else(|e| {
            eprintln!("Error writing support matrix: {e}");
            std::process::exit(1);
        });
    eprintln!("  Wrote {} entries to {:?}", matrix_entries.len(), matrix_path);

    // ── 3. Write shape map ────────────────────────────────────────────
    eprintln!("Generating shape map...");
    let shape_map_path = output_dir.join("decode_microphase_shape_map.json");
    serde_json::to_writer_pretty(std::fs::File::create(&shape_map_path).unwrap(), &ALL_DECODE_SHAPES)
        .unwrap_or_else(|e| {
            eprintln!("Error writing shape map: {e}");
            std::process::exit(1);
        });
    eprintln!("  Wrote {} profiles to {:?}", ALL_DECODE_SHAPES.len(), shape_map_path);

    // ── 4. Write receipt index ────────────────────────────────────────
    eprintln!("Generating receipt index...");
    let index_entries: Vec<ReceiptIndexEntry> = manifest.rows.iter().map(|row| {
        let backend = backend_kind_from_str(&row.backend);
        let status = decode_microphase_support_for(&row.family, backend);
        let (is_blocked, is_eligible) = match &status {
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Native => (false, true),
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Composed => (false, true),
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Unsupported { .. } => (true, false),
            tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Pending { .. } => (true, false),
        };
        ReceiptIndexEntry {
            row_id: row.row_id.clone(),
            tier: "tier2".into(),
            family: row.family.clone(),
            shape_profile: row.shape_profile.clone(),
            semantic_shape_profile: row.semantic_shape_profile.clone(),
            semantic_contract_id: row.semantic_contract_id.clone(),
            pipeline_phase: row.pipeline_phase.clone().unwrap_or_default(),
            backend: row.backend.clone(),
            backend_policy: row.backend_policy.clone(),
            support_status: match &status {
                tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Native => "supported_native",
                tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Composed => "supported_domain_adapter",
                tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Unsupported { .. } => "unsupported",
                tribunus_compute_native::pipeline_parity::PhaseSupportStatus::Pending { .. } => "pending",
            }.into(),
            blocked: is_blocked,
            comparison_eligible: is_eligible,
            kv_contract_ids: Vec::new(),
        }
    }).collect();

    let index_path = output_dir.join("decode_microphase_receipt_index.json");
    serde_json::to_writer_pretty(std::fs::File::create(&index_path).unwrap(), &index_entries)
        .unwrap_or_else(|e| {
            eprintln!("Error writing receipt index: {e}");
            std::process::exit(1);
        });
    eprintln!("  Wrote {} entries to {:?}", index_entries.len(), index_path);

    // ── 5. Generate and write KV contracts ─────────────────────────────
    eprintln!("Generating KV contracts...");
    let kv_backends = ["coreml", "mlx", "accelerate"];
    let all_kv_contracts: Vec<_> = ALL_DECODE_SHAPES.iter().flat_map(|binding| {
        kv_backends.iter().flat_map(|&backend_name| {
            let backend = backend_kind_from_str(backend_name);
            kv_contracts_for_backend(binding, backend)
        })
    }).collect();
    let kv_path = output_dir.join("kv_contracts.json");
    serde_json::to_writer_pretty(std::fs::File::create(&kv_path).unwrap(), &all_kv_contracts)
        .unwrap_or_else(|e| {
            eprintln!("Error writing KV contracts: {e}");
            std::process::exit(1);
        });
    eprintln!("  Wrote {} entries to {:?}", all_kv_contracts.len(), kv_path);

    let elapsed = start.elapsed();
    eprintln!();
    eprintln!("=== Tier 2 Batch 1 manifest summary ===");
    eprintln!("  Rows: {}", manifest.rows.len());
    let native_count = matrix_entries.iter().filter(|e| e.support_status == "supported_native").count();
    let composed_count = matrix_entries.iter().filter(|e| e.support_status == "supported_domain_adapter").count();
    let pending_count = matrix_entries.iter().filter(|e| e.support_status.starts_with("pending")).count();
    let unsupported_count = matrix_entries.iter().filter(|e| e.support_status.starts_with("unsupported")).count();
    let blocked_count = matrix_entries.iter().filter(|e| e.blocked_by_tier1_defect.is_some()).count();
    eprintln!("  Native:     {native_count}");
    eprintln!("  Composed:   {composed_count}");
    eprintln!("  Pending:    {pending_count}");
    eprintln!("  Unsupported: {unsupported_count}");
    eprintln!("  Blocked by Tier 1: {blocked_count}");
    eprintln!();
    eprintln!("Generated in {:.1}s", elapsed.as_secs_f64());
}
