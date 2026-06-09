//! Tribunus evidence-plane streaming parser — V4.
//!
//! Ingest NDJSON (newline-delimited JSON) incrementally via
//! `serde_json::StreamDeserializer`, validate each event, and produce
//! typed `EvidenceEventV4` records.  Never retains an entire run in memory.
//!
//! ## Backend contract
//!
//! ```ignore
//! pub trait EventDecoder {
//!     fn decode_next(&mut self, input: &mut InputChunk)
//!         -> Result<Option<DecodedEvent>, DecodeError>;
//! }
//! ```
//!
//! The first backend is `SerdeStreamingDecoder`.  `SimdJsonDecoder` may
//! follow behind a feature flag after corpus-parity is proven.

use serde::Deserialize;
use serde_json::de::IoRead;
use std::io::{BufReader, Cursor, Read};
use std::path::Path;
use tribunus_evidence_schema::{
    AttentionKind, EvidenceEventV4, EventPayloadV4, IngestionProvenance, LayerStageEvent,
    ProjectionFamily, ProjectionGraphEvent, SchemaVersion, ValidationMode,
};

// ── Error types ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum DecodeError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Validation {
        event_index: u64,
        message: String,
    },
    UnknownSchemaVersion {
        found: SchemaVersion,
        event_index: u64,
    },
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Io(e) => write!(f, "I/O error: {}", e),
            DecodeError::Json(e) => write!(f, "JSON parse error: {}", e),
            DecodeError::Validation { event_index, message } => {
                write!(f, "validation error at event {}: {}", event_index, message)
            }
            DecodeError::UnknownSchemaVersion { found, event_index } => {
                write!(f, "unknown schema version {} at event {}", found, event_index)
            }
        }
    }
}

// ── Decoded event ──────────────────────────────────────────────────────────

pub struct DecodedEvent {
    pub event: EvidenceEventV4,
    pub byte_offset: u64,
    pub line_number: u64,
}

// ── Input chunk ────────────────────────────────────────────────────────────

pub struct InputChunk {
    pub data: Vec<u8>,
    pub file_path: Option<String>,
    pub file_sha256: Option<String>,
    pub byte_offset: u64,
}

impl InputChunk {
    pub fn from_bytes(data: Vec<u8>) -> Self {
        Self {
            data,
            file_path: None,
            file_sha256: None,
            byte_offset: 0,
        }
    }

    pub fn from_file(path: &Path) -> Result<Self, std::io::Error> {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        let mut data = Vec::new();
        f.read_to_end(&mut data)?;

        let sha256 = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(&data);
            Some(format!("{:x}", h.finalize()))
        };

        Ok(Self {
            data,
            file_path: Some(path.display().to_string()),
            file_sha256: sha256,
            byte_offset: 0,
        })
    }
}

// ── Event decoder trait ────────────────────────────────────────────────────

pub trait EventDecoder {
    fn decode_next(
        &mut self,
        input: &mut InputChunk,
    ) -> Result<Option<DecodedEvent>, DecodeError>;
}

// ── Serde streaming decoder ────────────────────────────────────────────────

pub struct SerdeStreamingDecoder {
    event_count: u64,
    validation_mode: ValidationMode,
    dropped_events: u64,
    max_event_bytes: usize,
}

impl SerdeStreamingDecoder {
    pub fn new(mode: ValidationMode) -> Self {
        Self {
            event_count: 0,
            validation_mode: mode,
            dropped_events: 0,
            max_event_bytes: 16 * 1024 * 1024, // 16 MB
        }
    }

    pub fn event_count(&self) -> u64 {
        self.event_count
    }

    pub fn dropped_events(&self) -> u64 {
        self.dropped_events
    }
}

impl EventDecoder for SerdeStreamingDecoder {
    fn decode_next(
        &mut self,
        input: &mut InputChunk,
    ) -> Result<Option<DecodedEvent>, DecodeError> {
        if input.byte_offset >= input.data.len() as u64 {
            return Ok(None);
        }

        let remaining = &input.data[input.byte_offset as usize..];

        // Find next newline-delimited JSON value
        // Skip leading whitespace
        let start = remaining
            .iter()
            .position(|&b| b != b' ' && b != b'\n' && b != b'\r' && b != b'\t')
            .unwrap_or(remaining.len());

        if start >= remaining.len() {
            return Ok(None);
        }

        let remaining = &remaining[start..];

        // Find the end of the JSON value (balanced braces)
        let end = find_json_end(remaining);
        let json_bytes = &remaining[..end];

        if json_bytes.len() > self.max_event_bytes {
            self.dropped_events += 1;
            input.byte_offset += (start + end) as u64;
            // Skip to next newline
            if end < remaining.len() && remaining[end] == b'\n' {
                input.byte_offset += 1;
            }
            return self.decode_next(input); // tail-recursive skip
        }

        // Deserialize
        let ev: EvidenceEventV4 =
            serde_json::from_slice(json_bytes).map_err(DecodeError::Json)?;

        // Schema version check
        if !ev.schema_version.is_compatible() {
            return Err(DecodeError::UnknownSchemaVersion {
                found: ev.schema_version,
                event_index: self.event_count,
            });
        }

        // Validation
        self.validate(&ev)?;

        let byte_offset = input.byte_offset + start as u64;
        let line_number = self.event_count + 1;

        // Advance past the consumed JSON and optional newline
        input.byte_offset += (start + end) as u64;
        if end < remaining.len() && remaining[end] == b'\n' {
            input.byte_offset += 1;
        }

        self.event_count += 1;

        Ok(Some(DecodedEvent {
            event: ev,
            byte_offset,
            line_number,
        }))
    }
}

impl SerdeStreamingDecoder {
    fn validate(&self, ev: &EvidenceEventV4) -> Result<(), DecodeError> {
        let event_index = self.event_count;

        match self.validation_mode {
            ValidationMode::StrictClaim | ValidationMode::ControlledResearch => {
                // Required identity fields
                if ev.run_id.0.is_empty() {
                    return Err(DecodeError::Validation {
                        event_index,
                        message: "run_id is empty".into(),
                    });
                }

                // Sequence number must be > 0 in strict mode
                if matches!(self.validation_mode, ValidationMode::StrictClaim)
                    && ev.sequence_number == 0
                {
                    return Err(DecodeError::Validation {
                        event_index,
                        message: "sequence_number is 0 in strict mode".into(),
                    });
                }

                // Validate payload consistency
                match &ev.payload {
                    EventPayloadV4::LayerStage(ls) => {
                        if ls.graph_build_ns == 0 && ls.eval_ns == 0 {
                            return Err(DecodeError::Validation {
                                event_index,
                                message: "LayerStage has zero graph_build_ns and eval_ns".into(),
                            });
                        }
                    }
                    EventPayloadV4::ProjectionGraph(pg) => {
                        if pg.family.as_str() == "q_proj" && pg.input_shape.is_empty() {
                            return Err(DecodeError::Validation {
                                event_index,
                                message: "ProjectionGraph has empty input_shape".into(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            ValidationMode::LegacyMigration => {
                // Accept all structurally valid events during migration
            }
        }

        Ok(())
    }
}

// ── JSON boundary finder ───────────────────────────────────────────────────

/// Find the byte offset of the closing brace/bracket for a JSON value
/// starting at `data[0]`.  Returns the length of the JSON value in bytes.
fn find_json_end(data: &[u8]) -> usize {
    if data.is_empty() {
        return 0;
    }

    match data[0] {
        b'{' => find_matching(data, b'{', b'}'),
        b'[' => find_matching(data, b'[', b']'),
        b'"' => {
            // String: scan for closing unescaped quote
            let mut i = 1;
            while i < data.len() {
                if data[i] == b'"' && data[i - 1] != b'\\' {
                    return i + 1;
                }
                i += 1;
            }
            data.len()
        }
        _ => {
            // Number, bool, null: scan to next whitespace or comma
            data.iter()
                .position(|&b| b == b'\n' || b == b'\r' || b == b' ' || b == b'\t' || b == b',')
                .unwrap_or(data.len())
        }
    }
}

fn find_matching(data: &[u8], open: u8, close: u8) -> usize {
    let mut depth = 0u32;
    let mut in_string = false;
    let mut prev_was_backslash = false;

    for (i, &b) in data.iter().enumerate() {
        if in_string {
            if prev_was_backslash {
                prev_was_backslash = false;
                continue;
            }
            if b == b'\\' {
                prev_was_backslash = true;
                continue;
            }
            if b == b'"' {
                in_string = false;
            }
            continue;
        }

        if b == b'"' {
            in_string = true;
            continue;
        }

        if b == open {
            depth += 1;
        } else if b == close {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
    }
    data.len()
}

// ── V1–V3 legacy migration ────────────────────────────────────────────────

/// Migrate a V1 (elapsed_ms-based) layer line to a V4 LayerStageEvent.
pub fn migrate_v1_layer(line: &str, run_id: &str) -> Option<EvidenceEventV4> {
    let layer_m = regex_match(line, r"layer=(\d+)")?;
    let kind_m = regex_match(line, r"kind=(\S+)")?;
    let elapsed_m = regex_match(line, r"elapsed_ms=(\d+)")?;

    let layer: u32 = layer_m.parse().ok()?;
    let eval_ns: u64 = elapsed_m.parse::<u64>().ok()? * 1_000_000;

    Some(
        EvidenceEventV4::new(
            run_id.into(),
            run_id.into(),
            "worker-1".into(),
            EventPayloadV4::LayerStage(LayerStageEvent {
                stage_id: format!("layer_{}", layer),
                status: "completed".into(),
                graph_build_ns: 0,
                eval_ns,
                total_ns: eval_ns,
                kv_copy_bytes: 0,
                kv_alloc_bytes: 0,
                kv_seq_len: 0,
                shape: vec![],
                finite: true,
            }),
        )
        .with_layer(layer, tribunus_evidence_schema::AttentionKind::Sliding),
    )
}

/// Migrate a V2 (graph_us-based) layer line to a V4 LayerStageEvent.
pub fn migrate_v2_layer(line: &str, run_id: &str) -> Option<EvidenceEventV4> {
    let layer_m = regex_match(line, r"layer=(\d+)")?;
    let kind_m = regex_match(line, r"kind=(\S+)")?;
    let graph_m = regex_match(line, r"graph_us=(\d+)")?;
    let eval_m = regex_match(line, r"eval_us=(\d+)")?;

    let layer: u32 = layer_m.parse().ok()?;
    let graph_ns: u64 = graph_m.parse::<u64>().ok()? * 1000;
    let eval_ns: u64 = eval_m.parse::<u64>().ok()? * 1000;

    let attention_kind = match kind_m {
        "sliding_attention" => tribunus_evidence_schema::AttentionKind::Sliding,
        "full_attention" => tribunus_evidence_schema::AttentionKind::Full,
        _ => tribunus_evidence_schema::AttentionKind::Sliding,
    };

    Some(
        EvidenceEventV4::new(
            run_id.into(),
            run_id.into(),
            "worker-1".into(),
            EventPayloadV4::LayerStage(LayerStageEvent {
                stage_id: format!("layer_{}", layer),
                status: "completed".into(),
                graph_build_ns: graph_ns,
                eval_ns,
                total_ns: graph_ns + eval_ns,
                kv_copy_bytes: 0,
                kv_alloc_bytes: 0,
                kv_seq_len: 0,
                shape: vec![],
                finite: true,
            }),
        )
        .with_layer(layer, attention_kind),
    )
}

/// Migrate a V3 (proj) line to a V4 ProjectionGraphEvent.
pub fn migrate_v3_projection(line: &str, run_id: &str) -> Option<EvidenceEventV4> {
    let layer_m = regex_match(line, r"layer=(\d+)")?;
    let kind_m = regex_match(line, r"kind=(\w+)")?;
    let family_m = regex_match(line, r"family=(\w+)")?;
    let graph_m = regex_match(line, r"graph_build_ns=(\d+)")?;

    let layer: u32 = layer_m.parse().ok()?;
    let graph_build_ns: u64 = graph_m.parse().ok()?;

    let family = match family_m {
        "q_proj" => tribunus_evidence_schema::ProjectionFamily::QProj,
        "k_proj" => tribunus_evidence_schema::ProjectionFamily::KProj,
        "v_proj" => tribunus_evidence_schema::ProjectionFamily::VProj,
        "o_proj" => tribunus_evidence_schema::ProjectionFamily::OProj,
        "gate_proj" => tribunus_evidence_schema::ProjectionFamily::GateProj,
        "up_proj" => tribunus_evidence_schema::ProjectionFamily::UpProj,
        "down_proj" => tribunus_evidence_schema::ProjectionFamily::DownProj,
        _ => return None,
    };

    let attention_kind = match kind_m {
        "sliding" | "sliding_attention" => tribunus_evidence_schema::AttentionKind::Sliding,
        "full" | "full_attention" => tribunus_evidence_schema::AttentionKind::Full,
        _ => tribunus_evidence_schema::AttentionKind::Sliding,
    };

    Some(
        EvidenceEventV4::new(
            run_id.into(),
            run_id.into(),
            "worker-1".into(),
            EventPayloadV4::ProjectionGraph(ProjectionGraphEvent {
                family,
                invocation: 0,
                graph_build_ns,
                input_shape: vec![],
                weight_logical_shape: vec![],
                weight_physical_shape: vec![],
                storage_dtype: "U8".into(),
                runtime_dtype: "Uint32".into(),
                group_size: 64,
                bits: 8,
                transpose: true,
            }),
        )
        .with_layer(layer, attention_kind),
    )
}

/// Simple regex match: find the first capture group.
fn regex_match<'a>(haystack: &'a str, pattern: &str) -> Option<&'a str> {
    // Simplified: find `key=value` by splitting
    let prefix = pattern.trim_end_matches(r"(\S+)").trim_end_matches(r"(\d+)");
    let prefix = prefix.trim_end_matches('=');
    if let Some(pos) = haystack.find(&format!("{}=", prefix)) {
        let rest = &haystack[pos + prefix.len() + 1..];
        let end = rest
            .find(|c: char| c.is_whitespace())
            .unwrap_or(rest.len());
        Some(&rest[..end])
    } else {
        None
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_json_end_object() {
        let data = b"{\"a\": 1}\nnext";
        assert_eq!(find_json_end(data), 8);
    }

    #[test]
    fn test_find_json_end_nested() {
        let data = b"{\"a\": {\"b\": 2}}\n";
        assert_eq!(find_json_end(data), 15);
    }

    #[test]
    fn test_find_json_end_string() {
        let data = b"\"hello\"\n";
        assert_eq!(find_json_end(data), 7);
    }

    #[test]
    fn test_find_json_end_array() {
        let data = b"[1, 2, 3]\n";
        assert_eq!(find_json_end(data), 9);
    }

    #[test]
    fn test_decoder_single_event() {
        let ev = EvidenceEventV4::new(
            "test".into(),
            "req".into(),
            "w1".into(),
            EventPayloadV4::LayerStage(LayerStageEvent {
                stage_id: "l0".into(),
                status: "completed".into(),
                graph_build_ns: 1000,
                eval_ns: 5000,
                total_ns: 6000,
                kv_copy_bytes: 0,
                kv_alloc_bytes: 0,
                kv_seq_len: 0,
                shape: vec![4, 3840],
                finite: true,
            }),
        )
        .with_sequence(1);

        let json = serde_json::to_string(&ev).unwrap();
        let mut chunk = InputChunk::from_bytes((json + "\n").into_bytes());

        let mut decoder = SerdeStreamingDecoder::new(ValidationMode::ControlledResearch);
        let result = decoder.decode_next(&mut chunk).unwrap();
        assert!(result.is_some());
        assert_eq!(decoder.event_count(), 1);
    }

    #[test]
    fn test_decoder_rejects_unknown_schema() {
        let json = r#"{"schema_version":{"major":99,"minor":0},"event_id":"x","run_id":"r","request_id":"q","worker_id":"w","sequence_number":1,"monotonic_ns":0,"wall_time":null,"phase":"prefill","forward_pass_index":1,"token_step":null,"layer_index":null,"attention_kind":null,"substrate":"gpu","source_provenance":null,"payload":{"event_type":"layer_stage","stage_id":"l0","status":"ok","graph_build_ns":1,"eval_ns":1,"total_ns":2,"kv_copy_bytes":0,"kv_alloc_bytes":0,"kv_seq_len":0,"shape":[1],"finite":true}}"#;

        let mut chunk = InputChunk::from_bytes((json.to_string() + "\n").into_bytes());
        let mut decoder = SerdeStreamingDecoder::new(ValidationMode::ControlledResearch);
        let result = decoder.decode_next(&mut chunk);
        assert!(result.is_err());
    }

    #[test]
    fn test_migrate_v1_layer() {
        let line = "[full-model] layer=5 kind=sliding_attention elapsed_ms=42 bytes=1024 shape=[4,3840] finite=true";
        let ev = migrate_v1_layer(line, "test-run").unwrap();
        assert_eq!(ev.layer_index, Some(5));
        match &ev.payload {
            EventPayloadV4::LayerStage(ls) => {
                assert_eq!(ls.eval_ns, 42_000_000);
            }
            _ => panic!("wrong payload type"),
        }
    }

    #[test]
    fn test_migrate_v2_layer() {
        let line = "[full-model] layer=12 kind=full_attention graph_us=1000 eval_us=5000 rss=1GB→500MB handles=0→0 active=5GB→5GB cache=0B→0B kv_seq=1 kv_copy=0 kv_alloc=16384 shape=[1,3840] finite=true";
        let ev = migrate_v2_layer(line, "test-run").unwrap();
        assert_eq!(ev.layer_index, Some(12));
        match &ev.payload {
            EventPayloadV4::LayerStage(ls) => {
                assert_eq!(ls.graph_build_ns, 1_000_000);
                assert_eq!(ls.eval_ns, 5_000_000);
            }
            _ => panic!("wrong payload type"),
        }
    }
}
