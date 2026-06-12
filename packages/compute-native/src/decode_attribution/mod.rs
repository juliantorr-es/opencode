//! Decode Attribution Data Collection Gate.
//!
//! This module implements a measurement harness for Core ML decode
//! attribution: structured JSONL receipts capturing materialization,
//! compilation, load, warmup, and prediction timing across matrices
//! (compute-unit × graph family, shape × graph family), with reference
//! numerical conformance against the pure-Rust evaluator.

pub mod receipt;
pub mod coreml_minimal_repro;
pub mod graph_catalog;
pub mod shape_profiles;
pub mod statistics;
pub mod environment;
pub mod compute_plan;
pub mod harness;
pub mod timer_calibration;
pub mod breadcrumb;
pub mod artifact_hash;
pub mod matrices;
pub mod negative_evidence;
pub mod suite_manifest;
pub mod decode_microphase_shape_map;
pub mod report;
pub mod defect_clustering;
pub mod gap_report;
pub mod backend_adapters;
