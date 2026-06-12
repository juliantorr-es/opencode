//! tribunus-evidence — CLI for the Tribunus evidence plane.
//!
//! Commands:
//!   ingest <file>       — Stream NDJSON, validate, produce Arrow batches
//!   validate <file>     — Validate only (no Arrow output)
//!   inspect <file>      — Print event summary
//!   migrate <file>      — Migrate V1-V3 text logs to V4 NDJSON

use std::path::Path;
use tribunus_evidence_arrow::BatchDispatcher;
use tribunus_evidence_parser::{EventDecoder, InputChunk, SerdeStreamingDecoder};
use tribunus_evidence_schema::ValidationMode;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage:");
        eprintln!("  tribunus-evidence ingest <file.ndjson>");
        eprintln!("  tribunus-evidence validate <file.ndjson>");
        eprintln!("  tribunus-evidence inspect <file.ndjson>");
        std::process::exit(1);
    }

    let command = &args[1];
    let file_path = &args[2];

    match command.as_str() {
        "ingest" => cmd_ingest(file_path),
        "validate" => cmd_validate(file_path),
        "inspect" => cmd_inspect(file_path),
        other => {
            eprintln!("unknown command: {}", other);
            std::process::exit(1);
        }
    }
}

fn cmd_ingest(file_path: &str) {
    let path = Path::new(file_path);
    let mut chunk = match InputChunk::from_file(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error reading {}: {}", file_path, e);
            std::process::exit(1);
        }
    };

    eprintln!(
        "ingesting {} ({} bytes, sha256={})",
        file_path,
        chunk.data.len(),
        chunk.file_sha256.as_deref().unwrap_or("unknown")
    );

    let mut decoder = SerdeStreamingDecoder::new(ValidationMode::ControlledResearch);
    let mut dispatcher = BatchDispatcher::new(8192);
    let mut total_rows = 0usize;

    loop {
        match decoder.decode_next(&mut chunk) {
            Ok(Some(decoded)) => {
                dispatcher.dispatch(&decoded.event);
                total_rows += 1;

                let batches = dispatcher.flush_all();
                for (table_name, batch) in batches {
                    eprintln!("  flushed {} ({} rows)", table_name, batch.num_rows());
                }
            }
            Ok(None) => break,
            Err(e) => {
                eprintln!("error at event {}: {}", decoder.event_count(), e);
                if decoder.event_count() > 0 {
                    eprintln!(
                        "  (continuing — {} events ingested before error)",
                        decoder.event_count()
                    );
                }
                std::process::exit(1);
            }
        }
    }

    // Final flush
    let final_batches = dispatcher.flush_all_final();
    for (table_name, batch) in final_batches {
        eprintln!("  final flush {} ({} rows)", table_name, batch.num_rows());
    }

    eprintln!(
        "done: {} events, {} dropped, {} total rows",
        decoder.event_count(),
        decoder.dropped_events(),
        total_rows
    );
}

fn cmd_validate(file_path: &str) {
    let path = Path::new(file_path);
    let mut chunk = match InputChunk::from_file(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error reading {}: {}", file_path, e);
            std::process::exit(1);
        }
    };

    let mut decoder = SerdeStreamingDecoder::new(ValidationMode::StrictClaim);
    let mut errors = 0u64;

    loop {
        match decoder.decode_next(&mut chunk) {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(e) => {
                eprintln!("validation error at event {}: {}", decoder.event_count(), e);
                errors += 1;
            }
        }
    }

    if errors > 0 {
        eprintln!(
            "{} events processed, {} validation errors",
            decoder.event_count(),
            errors
        );
        std::process::exit(1);
    }

    eprintln!("{} events validated — all passed", decoder.event_count());
}

fn cmd_inspect(file_path: &str) {
    let path = Path::new(file_path);
    let mut chunk = match InputChunk::from_file(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error reading {}: {}", file_path, e);
            std::process::exit(1);
        }
    };

    let mut decoder = SerdeStreamingDecoder::new(ValidationMode::ControlledResearch);
    let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();

    loop {
        match decoder.decode_next(&mut chunk) {
            Ok(Some(decoded)) => {
                let tag = match &decoded.event.payload {
                    tribunus_evidence_schema::EventPayloadV4::LayerStage(_) => "layer_stage",
                    tribunus_evidence_schema::EventPayloadV4::ProjectionGraph(_) => {
                        "projection_graph"
                    }
                    tribunus_evidence_schema::EventPayloadV4::ProjectionReplay(_) => {
                        "projection_replay"
                    }
                    tribunus_evidence_schema::EventPayloadV4::MetalCommand(_) => "metal_command",
                    tribunus_evidence_schema::EventPayloadV4::MemorySample(_) => "memory_sample",
                    tribunus_evidence_schema::EventPayloadV4::CorrectnessCheckpoint(_) => {
                        "correctness"
                    }
                    tribunus_evidence_schema::EventPayloadV4::ModelLoad(_) => "model_load",
                    tribunus_evidence_schema::EventPayloadV4::TokenMetric(_) => "token_metric",
                    tribunus_evidence_schema::EventPayloadV4::Lifecycle(_) => "lifecycle",
                    tribunus_evidence_schema::EventPayloadV4::Diagnostic(_) => "diagnostic",
                    tribunus_evidence_schema::EventPayloadV4::ResourceLifecycle(_) => {
                        "resource_lifecycle"
                    }
                    tribunus_evidence_schema::EventPayloadV4::ConditioningRecipe(_) => {
                        "conditioning_recipe"
                    }
                    tribunus_evidence_schema::EventPayloadV4::PrefetchLifecycle(_) => {
                        "prefetch_lifecycle"
                    }
                    tribunus_evidence_schema::EventPayloadV4::ReadinessTransition(_) => {
                        "readiness_transition"
                    }
                    tribunus_evidence_schema::EventPayloadV4::TreatmentSummary(_) => {
                        "treatment_summary"
                    }
                };
                *counts.entry(tag.to_string()).or_insert(0) += 1;
            }
            Ok(None) => break,
            Err(e) => {
                eprintln!("error at event {}: {}", decoder.event_count(), e);
                break;
            }
        }
    }

    println!("Event summary ({} total):", decoder.event_count());
    let mut sorted: Vec<_> = counts.iter().collect();
    sorted.sort_by_key(|(_, c)| std::cmp::Reverse(**c));
    for (tag, count) in sorted {
        println!("  {:>20}: {}", tag, count);
    }
}
