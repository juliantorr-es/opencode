//! Write `.mlpackage` directory bundles from `coreml-proto` Model protobufs.
//!
//! Produces Apple-standard structure:
//! ```text
//! model.mlpackage/
//!   Manifest.json
//!   Data/
//!     com.apple.CoreML/
//!       model.mlmodel    (protobuf-encoded Model)
//!       weights/          (weight blobs, optional)
//! ```
//!
//! The manifest uses Apple's UUID-based `itemInfoEntries` + `rootModelIdentifier`
//! format. UUIDs are derived deterministically from the model name + counter
//! so repeated builds produce byte-identical package contents.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use coreml_proto::proto::{self, model, mil_spec};
use prost::Message;

/// Write a complete `.mlpackage` directory from a MIL `Program`.
pub fn write_mlpackage(
    program: mil_spec::Program,
    output_dir: &Path,
    description: &ModelMeta,
) -> Result<PathBuf, String> {
    write_mlpackage_inner(program, output_dir, description, &HashMap::new())
}

/// Write an `.mlpackage` with external weight files.
pub fn write_mlpackage_with_weights(
    program: mil_spec::Program,
    output_dir: &Path,
    description: &ModelMeta,
    weights: &HashMap<String, Vec<u8>>,
) -> Result<PathBuf, String> {
    write_mlpackage_inner(program, output_dir, description, weights)
}

fn write_mlpackage_inner(
    program: mil_spec::Program,
    output_dir: &Path,
    description: &ModelMeta,
    weights: &HashMap<String, Vec<u8>>,
) -> Result<PathBuf, String> {
    let model = proto::Model {
        specification_version: 9,
        description: Some(proto::ModelDescription {
            predicted_feature_name: String::new(),
            predicted_probabilities_name: String::new(),
            metadata: Some(proto::Metadata {
                short_description: description.short_description.clone(),
                version_string: description.version.clone(),
                author: description.author.clone(),
                license: String::new(),
                user_defined: HashMap::new(),
            }),
            input: vec![],
            output: vec![],
            training_input: vec![],
            state: vec![],
            functions: vec![proto::FunctionDescription {
                name: description.function_name.clone(),
                input: description.inputs.iter().map(|(name, shape)| proto::FeatureDescription {
                    name: name.clone(),
                    short_description: String::new(),
                    r#type: Some(proto::FeatureType {
                        is_optional: false,
                        r#type: Some(proto::feature_type::Type::MultiArrayType(
                            proto::ArrayFeatureType {
                                data_type: proto::array_feature_type::ArrayDataType::Float32 as i32,
                                shape: shape.clone(),
                                shape_flexibility: None,
                                default_optional_value: None,
                            },
                        )),
                    }),
                }).collect(),
                output: description.outputs.iter().map(|(name, shape)| proto::FeatureDescription {
                    name: name.clone(),
                    short_description: String::new(),
                    r#type: Some(proto::FeatureType {
                        is_optional: false,
                        r#type: Some(proto::feature_type::Type::MultiArrayType(
                            proto::ArrayFeatureType {
                                data_type: proto::array_feature_type::ArrayDataType::Float32 as i32,
                                shape: shape.clone(),
                                shape_flexibility: None,
                                default_optional_value: None,
                            },
                        )),
                    }),
                }).collect(),
                state: vec![],
                predicted_feature_name: String::new(),
                predicted_probabilities_name: String::new(),
            }],
            default_function_name: description.function_name.clone(),
        }),
        is_updatable: false,
        r#type: Some(model::Type::MlProgram(program)),
    };

    let model_bytes = model.encode_to_vec();
    let package_name = format!("{}.mlpackage", sanitize_name(&description.model_name));
    let package_dir = output_dir.join(&package_name);
    let data_dir = package_dir.join("Data/com.apple.CoreML");
    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("mkdir {}: {}", data_dir.display(), e))?;

    let mlmodel_path = data_dir.join("model.mlmodel");
    fs::write(&mlmodel_path, &model_bytes)
        .map_err(|e| format!("write {}: {}", mlmodel_path.display(), e))?;

    if !weights.is_empty() {
        let weights_dir = data_dir.join("weights");
        fs::create_dir_all(&weights_dir)
            .map_err(|e| format!("mkdir {}: {}", weights_dir.display(), e))?;
        for (name, data) in weights {
            let weight_path = weights_dir.join(format!("{}.bin", sanitize_name(name)));
            fs::write(&weight_path, data)
                .map_err(|e| format!("write {}: {}", weight_path.display(), e))?;
        }
    }

    // Apple-standard Manifest.json: UUID-based itemInfoEntries
    let model_uuid = deterministic_uuid(&description.model_name, 0);
    let mut item_info = serde_json::Map::new();
    item_info.insert(
        model_uuid.clone(),
        serde_json::json!({
            "author": "com.apple.CoreML",
            "description": "Core ML Model Specification",
            "name": "model.mlmodel",
            "path": "com.apple.CoreML/model.mlmodel"
        }),
    );
    let manifest = serde_json::json!({
        "fileFormatVersion": "1.0.0",
        "itemInfoEntries": item_info,
        "rootModelIdentifier": model_uuid,
    });
    let manifest_path = package_dir.join("Manifest.json");
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| format!("write {}: {}", manifest_path.display(), e))?;

    Ok(package_dir)
}

/// Metadata for the model description in the serialized protobuf.
#[derive(Debug, Clone)]
pub struct ModelMeta {
    pub model_name: String,
    pub function_name: String,
    pub short_description: String,
    pub version: String,
    pub author: String,
    pub output_name: String,
    pub inputs: Vec<(String, Vec<i64>)>,
    pub outputs: Vec<(String, Vec<i64>)>,
}

impl Default for ModelMeta {
    fn default() -> Self {
        Self {
            model_name: "tribunus-model".into(),
            function_name: "main".into(),
            short_description: "Tribunus compute region".into(),
            version: "1.0.0".into(),
            author: "Tribunus Compute".into(),
            output_name: "output".into(),
            inputs: vec![],
            outputs: vec![],
        }
    }
}

fn sanitize_name(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Generate a deterministic UUID-formatted string from a seed and counter.
/// Uses SHA-256 truncation to produce a stable 36-char UUID-like identifier.
fn deterministic_uuid(seed: &str, counter: u64) -> String {
    use sha2::Digest;
    let input = format!("{}:{}", seed, counter);
    let hash = sha2::Sha256::digest(input.as_bytes());
    // Format as 8-4-4-4-12 hex UUID
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        hash[0], hash[1], hash[2], hash[3],
        hash[4], hash[5], hash[6], hash[7],
        hash[8], hash[9], hash[10], hash[11],
        hash[12], hash[13], hash[14], hash[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mil_builder::MilBuilder;

    #[test]
    fn write_simple_matmul_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let prog = MilBuilder::new("main")
            .input("x", mil_spec::DataType::Float32, &[1, 4])
            .const_f32("w", &[1.0, 2.0, 3.0, 4.0], &[4, 1])
            .matmul("x", "w_0")
            .output("matmul_1")  // const_f32(w) takes ssa 0, matmul gets 1
            .build()
            .expect("MIL builder error");

        let meta = ModelMeta {
            inputs: vec![("x".into(), vec![1, 4])],
            outputs: vec![("output".into(), vec![1, 1])],
            output_name: "output".into(),
            ..Default::default()
        };

        let pkg_path = write_mlpackage(prog, tmp.path(), &meta).unwrap();
        assert!(pkg_path.join("Manifest.json").exists());
        assert!(pkg_path.join("Data/com.apple.CoreML/model.mlmodel").exists());

        // Verify manifest uses Apple's UUID-based format
        let manifest_bytes = fs::read(pkg_path.join("Manifest.json")).unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(manifest["fileFormatVersion"], "1.0.0");
        assert!(manifest["itemInfoEntries"].is_object());
        assert!(manifest["rootModelIdentifier"].is_string());

        let bytes = fs::read(pkg_path.join("Data/com.apple.CoreML/model.mlmodel")).unwrap();
        let model = proto::Model::decode(bytes.as_slice()).unwrap();
        assert_eq!(model.specification_version, 9);
        assert!(matches!(model.r#type, Some(model::Type::MlProgram(_))));
    }

    #[test]
    fn deterministic_uuid_stable() {
        let a = deterministic_uuid("test-model", 0);
        let b = deterministic_uuid("test-model", 0);
        assert_eq!(a, b, "same seed + counter must produce same UUID");
        let c = deterministic_uuid("test-model", 1);
        assert_ne!(a, c, "different counter must produce different UUID");
    }
}
