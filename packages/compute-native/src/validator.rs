//! Binding validator — proves the execution spec agrees with physical storage.
//!
//! Cross-references every tensor in the compiled ExecutionSpec against
//! actual safetensors headers (names, shapes, dtypes). Produces a machine-readable
//! report with pass/fail per tensor and an executable/not-executable verdict.
//!
//! This operates over safetensors metadata only — no arrays are materialized.

use crate::config::{AttentionKind, ExecutionSpec, QuantizationMeta, TensorBinding};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

// ── Safetensors header ─────────────────────────────────────────────────────

/// A tensor's metadata from a safetensors file header.
#[derive(Clone, Debug)]
pub struct TensorMeta {
    pub name: String,
    pub shape: Vec<u32>,
    pub dtype: String,
}

/// Safetensors index entry from model.safetensors.index.json.
#[derive(serde::Deserialize)]
struct SafetensorsIndex {
    weight_map: std::collections::HashMap<String, String>,
}

// ── Validation Report ──────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ValidationReport {
    pub validator_version: String,
    pub config_hash: String,
    pub shards: Vec<ShardInfo>,
    pub namespace: NamespaceInfo,
    pub architecture: ArchitectureSummary,
    pub bindings: Vec<BindingResult>,
    pub missing_tensors: Vec<String>,
    pub unexpected_tensors: Vec<UnexpectedTensor>,
    pub aliased_tensors: Vec<AliasInfo>,
    pub unsupported_features: Vec<String>,
    pub verdict: Verdict,
    pub stats: ValidationStats,
}

#[derive(serde::Serialize)]
pub struct ShardInfo {
    pub filename: String,
    pub sha256: String,
    pub header_sha256: String,
    pub tensor_count: usize,
}

#[derive(serde::Serialize)]
pub struct NamespaceInfo {
    pub root: String,
    pub discovery: String,
    pub lm_head_key: String,
    pub lm_head_aliased: bool,
}

#[derive(serde::Serialize)]
pub struct ArchitectureSummary {
    pub model_type: String,
    pub hidden_size: u32,
    pub intermediate_size: u32,
    pub n_heads: u32,
    pub n_kv_heads: u32,
    pub head_dim: u32,
    pub global_head_dim: Option<u32>,
    pub n_global_kv_heads: Option<u32>,
    pub n_layers: u32,
    pub vocab_size: u32,
    pub sliding_window: u32,
    pub tie_word_embeddings: bool,
    pub attention_k_eq_v: bool,
    pub final_logit_softcapping: Option<f64>,
    pub quantization_bits: Option<u32>,
    pub quantization_group_size: Option<u32>,
    pub layer_types: Vec<String>,
    pub sliding_layers: usize,
    pub full_layers: usize,
}

#[derive(serde::Serialize)]
pub struct BindingResult {
    pub tensor_name: String,
    pub role: String,
    pub exists: bool,
    pub logical_shape: Vec<u32>,
    pub actual_shape: Option<Vec<u32>>,
    pub actual_dtype: Option<String>,
    pub packed_shapes_match: Option<bool>,
    pub packed_detail: Option<String>,
    pub status: BindingStatus,
}

#[derive(serde::Serialize)]
pub enum BindingStatus {
    Ok,
    Missing,
    ShapeMismatch,
    DtypeMismatch { expected: String, actual: String },
    UnexpectedDtype,
    PackedShapeError(String),
}

#[derive(serde::Serialize)]
pub struct UnexpectedTensor {
    pub name: String,
    pub shape: Vec<u32>,
    pub dtype: String,
    pub classification: String, // "multimodal", "vision", "audio", "unknown"
}

#[derive(serde::Serialize)]
pub struct AliasInfo {
    pub logical_name: String,
    pub reason: String,
}

#[derive(serde::Serialize)]
pub struct Verdict {
    pub executable: bool,
    pub total_expected: usize,
    pub total_found: usize,
    pub errors: usize,
}

#[derive(serde::Serialize)]
pub struct ValidationStats {
    pub tensor_count: usize,
    pub quantized_linear_count: usize,
    pub sliding_layers: usize,
    pub full_attention_layers: usize,
}

// ── Classifier for unexpected tensors ──────────────────────────────────────

fn classify_unexpected(name: &str) -> &str {
    if name.contains("vision") || name.contains("mm_") {
        return "vision";
    }
    if name.contains("audio") {
        return "audio";
    }
    if name.ends_with(".layer_scalar") {
        return "per-layer-scalar";
    }
    if name.contains("language_model") && !name.contains(".model.") {
        return "multimodal-wrapper";
    }
    if name.ends_with(".scales") || name.ends_with(".biases") {
        return "quantization-metadata";
    }
    if name.contains("embed_tokens") && !name.ends_with(".weight") {
        return "quantization-metadata";
    }
    "unknown"
}

// ── Hash a file ────────────────────────────────────────────────────────────

fn sha256_file(path: &str) -> napi::Result<String> {
    let data = std::fs::read(path)
        .map_err(|e| napi::Error::from_reason(format!("Cannot read {}: {}", path, e)))?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(format!("{:x}", hasher.finalize()))
}

// ── Main validation entry point ────────────────────────────────────────────

/// Validate a model directory against a compiled execution spec.
///
/// 1. Reads safetensors headers from all shards.
/// 2. Resolves the namespace against actual tensor names.
/// 3. Cross-checks every expected tensor.
/// 4. Classifies unexpected tensors (multimodal wrappers are OK).
/// 5. Returns a report with executable/not-executable verdict.
pub fn validate_bindings(model_dir: &str, spec: &ExecutionSpec) -> napi::Result<ValidationReport> {
    use std::path::Path;

    let dir = Path::new(model_dir);
    let shards = discover_shards(dir)?;
    let mut all_meta: Vec<TensorMeta> = Vec::new();
    let mut shard_infos = Vec::new();

    for shard_path in &shards {
        let meta = read_safetensors_header(shard_path)?;
        let hash = sha256_file(shard_path.to_str().unwrap_or(""))?;
        shard_infos.push(ShardInfo {
            filename: shard_path.file_name().unwrap().to_string_lossy().into(),
            sha256: hash,
            header_sha256: String::new(), // header hash if computed separately
            tensor_count: meta.len(),
        });
        all_meta.extend(meta);
    }

    let names: Vec<String> = all_meta.iter().map(|m| m.name.clone()).collect();
    let namespace = crate::config::resolve_namespace(&names).ok_or_else(|| {
        napi::Error::from_reason(
            "Could not resolve text model namespace — no candidate matched anchors",
        )
    })?;

    let name_map: std::collections::HashMap<&str, &TensorMeta> =
        all_meta.iter().map(|m| (m.name.as_str(), m)).collect();

    let mut report = ValidationReport {
        validator_version: env!("CARGO_PKG_VERSION").into(),
        config_hash: "".into(),
        shards: shard_infos,
        namespace: NamespaceInfo {
            root: namespace.root.clone(),
            discovery: namespace.discovery.clone(),
            lm_head_key: namespace.lm_head_key.clone(),
            lm_head_aliased: namespace.lm_head_aliased,
        },
        architecture: ArchitectureSummary {
            model_type: spec.architecture.model_type.clone(),
            hidden_size: spec.architecture.hidden_size,
            intermediate_size: spec.architecture.intermediate_size,
            n_heads: spec.architecture.num_attention_heads,
            n_kv_heads: spec.architecture.num_key_value_heads,
            head_dim: spec.architecture.head_dim,
            global_head_dim: spec.architecture.global_head_dim,
            n_global_kv_heads: spec.architecture.num_global_key_value_heads,
            n_layers: spec.architecture.num_hidden_layers,
            vocab_size: spec.architecture.vocab_size,
            sliding_window: spec.architecture.sliding_window,
            tie_word_embeddings: spec.architecture.tie_word_embeddings,
            attention_k_eq_v: spec.architecture.attention_k_eq_v,
            final_logit_softcapping: spec.architecture.final_logit_softcapping,
            quantization_bits: spec.quantization.as_ref().map(|q| q.bits),
            quantization_group_size: spec.quantization.as_ref().map(|q| q.group_size),
            layer_types: spec
                .layers
                .iter()
                .map(|l| format!("{:?}", l.attention_kind))
                .collect(),
            sliding_layers: spec
                .layers
                .iter()
                .filter(|l| l.attention_kind == AttentionKind::SlidingAttention)
                .count(),
            full_layers: spec
                .layers
                .iter()
                .filter(|l| l.attention_kind == AttentionKind::FullAttention)
                .count(),
        },
        bindings: Vec::new(),
        missing_tensors: Vec::new(),
        unexpected_tensors: Vec::new(),
        aliased_tensors: Vec::new(),
        unsupported_features: Vec::new(),
        verdict: Verdict {
            executable: false,
            total_expected: 0,
            total_found: 0,
            errors: 0,
        },
        stats: ValidationStats {
            tensor_count: 0,
            quantized_linear_count: 0,
            sliding_layers: 0,
            full_attention_layers: 0,
        },
    };

    let mut expected_count = 0;
    let mut found_count = 0;
    let mut error_count = 0;
    let mut expected_names: HashSet<&str> = HashSet::new();
    let mut quantized_count = 0;

    // Validate global tensors
    for binding in &spec.global_tensors {
        expected_count += 1;
        expected_names.insert(&binding.name);
        let result = check_binding(binding, &name_map, &spec.quantization);
        if matches!(result.status, BindingStatus::Ok) {
            found_count += 1;
        } else {
            error_count += 1;
        }
        if binding.packed_shape.is_some() {
            quantized_count += 1;
        }
        report.bindings.push(result);
    }

    // Validate per-layer tensors
    for layer in &spec.layers {
        for binding in &layer.tensors {
            expected_count += 1;
            expected_names.insert(&binding.name);
            let result = check_binding(binding, &name_map, &spec.quantization);
            if matches!(result.status, BindingStatus::Ok) {
                found_count += 1;
            } else {
                error_count += 1;
            }
            if binding.packed_shape.is_some() {
                quantized_count += 1;
            }
            report.bindings.push(result);
        }
    }

    // Classify unexpected tensors
    for (name, meta) in &name_map {
        if !expected_names.contains(name) {
            report.unexpected_tensors.push(UnexpectedTensor {
                name: name.to_string(),
                shape: meta.shape.clone(),
                dtype: meta.dtype.clone(),
                classification: classify_unexpected(name).into(),
            });
        }
    }

    // Detect aliased tensors (tied embeddings)
    if spec.architecture.tie_word_embeddings {
        report.aliased_tensors.push(AliasInfo {
            logical_name: "lm_head.weight".into(),
            reason: "tie_word_embeddings=true — aliased to embed_tokens.weight".into(),
        });
    }

    // Unsupported features
    if spec.architecture.hidden_size_per_layer_input > 0 {
        report.unsupported_features.push(format!(
            "per_layer_embeddings: hidden_size_per_layer_input={}",
            spec.architecture.hidden_size_per_layer_input
        ));
    }
    if spec.architecture.final_logit_softcapping.is_some() {
        report
            .unsupported_features
            .push("final_logit_softcapping (not yet implemented)".into());
    }

    report.stats = ValidationStats {
        tensor_count: all_meta.len(),
        quantized_linear_count: quantized_count,
        sliding_layers: spec
            .layers
            .iter()
            .filter(|l| l.attention_kind == AttentionKind::SlidingAttention)
            .count(),
        full_attention_layers: spec
            .layers
            .iter()
            .filter(|l| l.attention_kind == AttentionKind::FullAttention)
            .count(),
    };

    report.verdict = Verdict {
        executable: error_count == 0 && !expected_names.is_empty(),
        total_expected: expected_count,
        total_found: found_count,
        errors: error_count,
    };

    Ok(report)
}

fn check_binding(
    binding: &TensorBinding,
    name_map: &std::collections::HashMap<&str, &TensorMeta>,
    _quant: &Option<QuantizationMeta>,
) -> BindingResult {
    let meta = name_map.get(binding.name.as_str());
    let exists = meta.is_some();

    let (actual_shape, actual_dtype, status) = if let Some(m) = meta {
        let shape_match = m.shape == binding.logical_shape;
        let packed_match = binding.packed_shape.as_ref().map(|p| p.weight == m.shape);

        let dtype_ok = match m.dtype.as_str() {
            "F32" | "F64" | "F16" | "BF16" => true,
            "I64" | "U32" | "I32" | "I8" | "U8" => true,
            _ => false,
        };

        let status = if !shape_match && packed_match != Some(true) {
            if let Some(ref p) = binding.packed_shape {
                BindingStatus::PackedShapeError(format!(
                    "expected logical {} or packed weight {}; got {}",
                    fmt_shape(&binding.logical_shape),
                    fmt_shape(&p.weight),
                    fmt_shape(&m.shape)
                ))
            } else {
                BindingStatus::ShapeMismatch
            }
        } else if !dtype_ok {
            BindingStatus::UnexpectedDtype
        } else {
            BindingStatus::Ok
        };

        (Some(m.shape.clone()), Some(m.dtype.clone()), status)
    } else {
        (None, None, BindingStatus::Missing)
    };

    let packed_detail = binding.packed_shape.as_ref().map(|p| {
        format!(
            "8-bit affine, group_size={}, groups={}, packed weight {} (logical {}), scales {}, biases {}",
            p.group_size,
            p.groups,
            fmt_shape(&p.weight),
            fmt_shape(&binding.logical_shape),
            fmt_shape(&p.scales),
            fmt_shape(&p.biases),
        )
    });

    BindingResult {
        tensor_name: binding.name.clone(),
        role: format!("{:?}", binding.role),
        exists,
        logical_shape: binding.logical_shape.clone(),
        actual_shape,
        actual_dtype,
        packed_shapes_match: binding
            .packed_shape
            .as_ref()
            .map(|p| meta.map(|m| m.shape == p.weight).unwrap_or(false)),
        packed_detail,
        status,
    }
}

fn fmt_shape(s: &[u32]) -> String {
    s.iter()
        .map(|d| d.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

// ── Safetensors header reading ────────────────────────────────────────────

fn read_safetensors_header(path: &std::path::Path) -> napi::Result<Vec<TensorMeta>> {
    eprintln!("[header] opening {:?}", path);
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| napi::Error::from_reason(format!("Cannot open {}: {}", path.display(), e)))?;

    eprintln!("[header] reading header size");
    let mut header_size_buf = [0u8; 8];
    file.read_exact(&mut header_size_buf).map_err(|e| {
        napi::Error::from_reason(format!(
            "Cannot read header size from {}: {}",
            path.display(),
            e
        ))
    })?;
    let header_size = u64::from_le_bytes(header_size_buf) as usize;
    eprintln!("[header] header_size={}", header_size);

    eprintln!("[header] reading header body");
    let mut header_buf = vec![0u8; header_size];
    file.read_exact(&mut header_buf).map_err(|e| {
        napi::Error::from_reason(format!("Cannot read header from {}: {}", path.display(), e))
    })?;

    eprintln!("[header] parsing metadata");
    let (_n, metadata) = safetensors::SafeTensors::read_metadata(&header_buf).map_err(|e| {
        napi::Error::from_reason(format!(
            "Bad safetensors header {}: {:?}",
            path.display(),
            e
        ))
    })?;

    eprintln!("[header] iterating {} tensors", metadata.tensors().len());
    let mut metas = Vec::with_capacity(metadata.tensors().len());
    for (name, info) in metadata.tensors() {
        metas.push(TensorMeta {
            name: name.to_string(),
            shape: info.shape.clone().iter().map(|&d| d as u32).collect(),
            dtype: format!("{:?}", info.dtype),
        });
    }
    eprintln!("[header] done, {} tensors", metas.len());
    Ok(metas)
}

pub fn discover_shards(dir: &std::path::Path) -> napi::Result<Vec<std::path::PathBuf>> {
    // Try index.json first, then glob for model-*.safetensors
    let index_path = dir.join("model.safetensors.index.json");
    if index_path.exists() {
        let index_json = std::fs::read_to_string(&index_path)
            .map_err(|e| napi::Error::from_reason(format!("Cannot read index: {}", e)))?;
        let index: SafetensorsIndex = serde_json::from_str(&index_json)
            .map_err(|e| napi::Error::from_reason(format!("Bad index JSON: {}", e)))?;

        let mut paths: Vec<std::path::PathBuf> =
            index.weight_map.values().map(|f| dir.join(f)).collect();
        paths.sort();
        paths.dedup();
        return Ok(paths);
    }

    // Fallback: find model*.safetensors files
    let mut paths = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".safetensors") {
                paths.push(entry.path());
            }
        }
    }
    paths.sort();
    Ok(paths)
}

/// Validate bindings using a pre-built name→meta map (avoids filesystem I/O).
/// The map is built from pre-read safetensors headers by the caller.
pub fn validate_bindings_from_map(
    name_map: &std::collections::HashMap<String, TensorMeta>,
    spec: &crate::config::ExecutionSpec,
) -> napi::Result<ValidationReport> {
    // Build a &str→&TensorMeta lookup
    let lookup: std::collections::HashMap<&str, &TensorMeta> =
        name_map.iter().map(|(k, v)| (k.as_str(), v)).collect();

    // Reuse the existing validate_bindings logic but skip shard reading
    let namespace = &spec.namespace;

    let mut report = ValidationReport {
        validator_version: env!("CARGO_PKG_VERSION").into(),
        config_hash: String::new(),
        shards: Vec::new(),
        namespace: NamespaceInfo {
            root: namespace.root.clone(),
            discovery: namespace.discovery.clone(),
            lm_head_key: namespace.lm_head_key.clone(),
            lm_head_aliased: namespace.lm_head_aliased,
        },
        architecture: ArchitectureSummary {
            model_type: spec.architecture.model_type.clone(),
            hidden_size: spec.architecture.hidden_size,
            intermediate_size: spec.architecture.intermediate_size,
            n_heads: spec.architecture.num_attention_heads,
            n_kv_heads: spec.architecture.num_key_value_heads,
            head_dim: spec.architecture.head_dim,
            global_head_dim: spec.architecture.global_head_dim,
            n_global_kv_heads: spec.architecture.num_global_key_value_heads,
            n_layers: spec.architecture.num_hidden_layers,
            vocab_size: spec.architecture.vocab_size,
            sliding_window: spec.architecture.sliding_window,
            tie_word_embeddings: spec.architecture.tie_word_embeddings,
            attention_k_eq_v: spec.architecture.attention_k_eq_v,
            final_logit_softcapping: spec.architecture.final_logit_softcapping,
            quantization_bits: spec.quantization.as_ref().map(|q| q.bits),
            quantization_group_size: spec.quantization.as_ref().map(|q| q.group_size),
            layer_types: spec
                .layers
                .iter()
                .map(|l| format!("{:?}", l.attention_kind))
                .collect(),
            sliding_layers: spec
                .layers
                .iter()
                .filter(|l| l.attention_kind == crate::config::AttentionKind::SlidingAttention)
                .count(),
            full_layers: spec
                .layers
                .iter()
                .filter(|l| l.attention_kind == crate::config::AttentionKind::FullAttention)
                .count(),
        },
        bindings: Vec::new(),
        missing_tensors: Vec::new(),
        unexpected_tensors: Vec::new(),
        aliased_tensors: Vec::new(),
        unsupported_features: Vec::new(),
        verdict: Verdict {
            executable: false,
            total_expected: 0,
            total_found: 0,
            errors: 0,
        },
        stats: ValidationStats {
            tensor_count: name_map.len(),
            quantized_linear_count: 0,
            sliding_layers: 0,
            full_attention_layers: 0,
        },
    };

    let mut expected_count = 0;
    let mut found_count = 0;
    let mut error_count = 0;
    let mut expected_names: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut quantized_count = 0;

    for binding in &spec.global_tensors {
        expected_count += 1;
        expected_names.insert(binding.name.as_str());
        let result = check_binding(binding, &lookup, &spec.quantization);
        if matches!(result.status, BindingStatus::Ok) {
            found_count += 1;
        } else {
            error_count += 1;
        }
        if binding.packed_shape.is_some() {
            quantized_count += 1;
        }
        report.bindings.push(result);
    }

    for layer in &spec.layers {
        for binding in &layer.tensors {
            expected_count += 1;
            expected_names.insert(binding.name.as_str());
            let result = check_binding(binding, &lookup, &spec.quantization);
            if matches!(result.status, BindingStatus::Ok) {
                found_count += 1;
            } else {
                error_count += 1;
            }
            if binding.packed_shape.is_some() {
                quantized_count += 1;
            }
            report.bindings.push(result);
        }
    }

    for (name, meta) in &lookup {
        if !expected_names.contains(name) {
            report.unexpected_tensors.push(UnexpectedTensor {
                name: name.to_string(),
                shape: meta.shape.clone(),
                dtype: meta.dtype.clone(),
                classification: classify_unexpected(name).into(),
            });
        }
    }

    if spec.architecture.tie_word_embeddings {
        report.aliased_tensors.push(AliasInfo {
            logical_name: "lm_head.weight".into(),
            reason: "tie_word_embeddings=true — aliased to embed_tokens.weight".into(),
        });
    }

    report.stats.quantized_linear_count = quantized_count;
    report.verdict = Verdict {
        executable: error_count == 0 && !expected_names.is_empty(),
        total_expected: expected_count,
        total_found: found_count,
        errors: error_count,
    };

    Ok(report)
}
