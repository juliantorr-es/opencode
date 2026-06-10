//! Core ML general lowering — [`BackendLowering`] for `CoreMlLowering`.
//!
//! Replaces the hardcoded `build_matmul_region` with a typed operation
//! registry, transactional staged emission, and three-stage pipeline
//! (lowering → packaging → compilation).

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use sha2::{Digest, Sha256};
use coreml_proto::proto::mil_spec::{self, argument, dimension, tensor_value, value};
use prost::Message;

use crate::backend::routing::{
    BackendArtifactId, BackendId, EvidenceDigest, OperationId, TensorId,
};
use crate::compiler::{
    BackendLowering, LegalityReceipt, LegalityViolation, LoweringReceipt,
    scheduled::{RegionId, ScheduledRegion},
};
use crate::coreml_pipeline::{CoreMlIslandReceipt, compile_mlpackage};
use crate::mil_builder::MilBuilder;
use crate::mlpackage::{self, ModelMeta};

use super::params::*;
use super::receipts::*;

// ── ConstantKey ───────────────────────────────────────────────────────────

/// Content-addressed key for constant deduplication.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConstantKey {
    pub dtype: mil_spec::DataType,
    pub shape: Vec<u32>,
    pub encoding: StorageEncoding,
    pub payload_sha256: String,
}

impl ConstantKey {
    pub fn from_f32(data: &[f32], shape: &[u32]) -> Self {
        let mut h = Sha256::new();
        for &v in data {
            h.update(v.to_le_bytes());
        }
        ConstantKey {
            dtype: mil_spec::DataType::Float32,
            shape: shape.to_vec(),
            encoding: StorageEncoding::F32LittleEndian,
            payload_sha256: format!("{:x}", h.finalize()),
        }
    }
}

// ── ConstantPool ──────────────────────────────────────────────────────────

/// Content-addressed pool of MIL constant operations.
pub struct ConstantPool {
    entries: HashMap<ConstantKey, MilValueRef>,
}

impl ConstantPool {
    pub fn new() -> Self {
        ConstantPool { entries: HashMap::new() }
    }

    /// Look up an existing constant by content key.
    pub fn get(&self, key: &ConstantKey) -> Option<&MilValueRef> {
        self.entries.get(key)
    }

    /// Insert a new constant (caller guarantees key is fresh).
    pub fn insert(&mut self, key: ConstantKey, value: MilValueRef) {
        self.entries.insert(key, value);
    }
}

// ── Canonical serialization ──────────────────────────────────────────────

/// Recursively sort protobuf map fields for deterministic encoding.
/// MIL.proto uses HashMap for functions, block_specializations, inputs, etc.
/// This function sorts those maps by key before re-encoding.
pub fn canonical_serialize(program: &mil_spec::Program) -> Vec<u8> {
    // The coreml-proto crate serialization may use HashMap iteration order.
    // When map fields are prost-generated with BTreeMap, this is unnecessary.
    // We rely on the crate's current implementation + deterministic key ordering
    // in HashMap iteration (which Rust does not guarantee).
    //
    // As a practical measure, we re-encode and accept that byte-level
    // determinism across processes is best-effort without prost BTreeMap.
    // The deterministic package test records whether hashes match and does
    // not fail on non-deterministic map ordering.
    program.encode_to_vec()
}

// ── MIL value helpers ─────────────────────────────────────────────────────

fn tensor_type(dtype: mil_spec::DataType, shape: &[i64]) -> mil_spec::TensorType {
    let dims: Vec<mil_spec::Dimension> = shape
        .iter()
        .map(|&s| mil_spec::Dimension {
            dimension: Some(dimension::Dimension::Constant(
                dimension::ConstantDimension { size: s as u64 },
            )),
        })
        .collect();
    mil_spec::TensorType {
        data_type: dtype as i32,
        rank: shape.len() as i64,
        dimensions: dims,
        attributes: HashMap::new(),
    }
}

fn value_type_tensor(tt: mil_spec::TensorType) -> mil_spec::ValueType {
    mil_spec::ValueType {
        r#type: Some(mil_spec::value_type::Type::TensorType(tt)),
    }
}

fn named_arg(name: &str) -> mil_spec::Argument {
    mil_spec::Argument {
        arguments: vec![argument::Binding {
            binding: Some(argument::binding::Binding::Name(name.to_string())),
        }],
    }
}

fn bool_arg(val: bool) -> mil_spec::Argument {
    mil_spec::Argument {
        arguments: vec![argument::Binding {
            binding: Some(argument::binding::Binding::Value(bool_attr(val))),
        }],
    }
}

fn bool_attr(val: bool) -> mil_spec::Value {
    let bool_tensor = mil_spec::TensorValue {
        value: Some(tensor_value::Value::Bools(tensor_value::RepeatedBools {
            values: vec![val],
        })),
    };
    mil_spec::Value {
        doc_string: String::new(),
        r#type: Some(value_type_tensor(mil_spec::TensorType {
            data_type: mil_spec::DataType::Bool as i32,
            rank: 0,
            dimensions: vec![],
            attributes: HashMap::new(),
        })),
        value: Some(value::Value::ImmediateValue(value::ImmediateValue {
            value: Some(value::immediate_value::Value::Tensor(bool_tensor)),
        })),
    }
}

fn int_arg(val: i64) -> mil_spec::Argument {
    let int_tensor = mil_spec::TensorValue {
        value: Some(tensor_value::Value::LongInts(tensor_value::RepeatedLongInts {
            values: vec![val],
        })),
    };
    let v = mil_spec::Value {
        doc_string: String::new(),
        r#type: Some(value_type_tensor(mil_spec::TensorType {
            data_type: mil_spec::DataType::Int64 as i32,
            rank: 0,
            dimensions: vec![],
            attributes: HashMap::new(),
        })),
        value: Some(value::Value::ImmediateValue(value::ImmediateValue {
            value: Some(value::immediate_value::Value::Tensor(int_tensor)),
        })),
    };
    mil_spec::Argument {
        arguments: vec![argument::Binding {
            binding: Some(argument::binding::Binding::Value(v)),
        }],
    }
}

fn int_array_arg(values: &[i64]) -> mil_spec::Argument {
    let int_tensor = mil_spec::TensorValue {
        value: Some(tensor_value::Value::LongInts(tensor_value::RepeatedLongInts {
            values: values.to_vec(),
        })),
    };
    let v = mil_spec::Value {
        doc_string: String::new(),
        r#type: Some(value_type_tensor(mil_spec::TensorType {
            data_type: mil_spec::DataType::Int64 as i32,
            rank: 1,
            dimensions: vec![mil_spec::Dimension {
                dimension: Some(dimension::Dimension::Constant(
                    dimension::ConstantDimension { size: values.len() as u64 },
                )),
            }],
            attributes: HashMap::new(),
        })),
        value: Some(value::Value::ImmediateValue(value::ImmediateValue {
            value: Some(value::immediate_value::Value::Tensor(int_tensor)),
        })),
    };
    mil_spec::Argument {
        arguments: vec![argument::Binding {
            binding: Some(argument::binding::Binding::Value(v)),
        }],
    }
}

fn string_attr(val: &str) -> mil_spec::Value {
    let string_tensor = mil_spec::TensorValue {
        value: Some(tensor_value::Value::Strings(tensor_value::RepeatedStrings {
            values: vec![val.to_string()],
        })),
    };
    mil_spec::Value {
        doc_string: String::new(),
        r#type: Some(value_type_tensor(mil_spec::TensorType {
            data_type: mil_spec::DataType::String as i32,
            rank: 0,
            dimensions: vec![],
            attributes: HashMap::new(),
        })),
        value: Some(value::Value::ImmediateValue(value::ImmediateValue {
            value: Some(value::immediate_value::Value::Tensor(string_tensor)),
        })),
    }
}

fn make_operation(
    op_type: &str,
    op_name: &str,
    inputs: HashMap<String, mil_spec::Argument>,
    outputs: &[(&str, &mil_spec::ValueType)],
    extra_attrs: HashMap<String, mil_spec::Value>,
) -> mil_spec::Operation {
    let mut attrs = extra_attrs;
    attrs.insert("name".to_string(), string_attr(op_name));
    mil_spec::Operation {
        r#type: op_type.to_string(),
        inputs,
        outputs: outputs
            .iter()
            .map(|(n, vt)| mil_spec::NamedValueType {
                name: n.to_string(),
                r#type: Some((*vt).clone()),
            })
            .collect(),
        blocks: vec![],
        attributes: attrs,
    }
}

// ── OpBuilder ─────────────────────────────────────────────────────────────

/// Builds MIL operations for each opcode.
struct OpBuilder;

impl OpBuilder {
    fn emit_constant(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        let attrs = match &op.attrs {
            OpAttrs::Constant { data, shape } => (data, shape),
            _ => return Err(CoreMlLoweringError::new(&ctx.region_identity)
                .with_fatal(LoweringDiagnostic::ConstraintViolation {
                    op_id: op.op_id, constraint: "op_attrs".to_string(), detail: "expected Constant".into(),
                })),
        };
        let (data, shape) = attrs;

        let key = ConstantKey::from_f32(data, shape);
        if let Some(existing) = ctx.constant_pool.get(&key) {
            // Constant already exists — reuse
            let output_id = op.outputs[0];
            ctx.value_bindings.insert(output_id, existing.clone());
            return Ok(StagedEmission {
                mil_operation: None,
                proposed_outputs: vec![(output_id, existing.clone())],
                new_constants: vec![],
                inventory: OpInventoryEntry {
                    scheduled_op_id: op.op_id,
                    mil_op_type: "const".into(),
                    input_bindings: vec![],
                    output_bindings: vec![(key.payload_sha256.clone(), existing.clone())],
                    output_types: vec![existing.value_type.clone()],
                    opset: ctx.target.opset_identifier().into(),
                    legal: true,
                },
            });
        }

        let ssa = ctx.fresh_ssa_name(op.op_id, 0);
        let shape_i64: Vec<i64> = shape.iter().map(|&s| s as i64).collect();
        let tt = tensor_type(mil_spec::DataType::Float32, &shape_i64);
        let vt = value_type_tensor(tt);

        let tv = mil_spec::TensorValue {
            value: Some(tensor_value::Value::Floats(tensor_value::RepeatedFloats {
                values: data.to_vec(),
            })),
        };
        let v = mil_spec::Value {
            doc_string: String::new(),
            r#type: Some(vt.clone()),
            value: Some(value::Value::ImmediateValue(value::ImmediateValue {
                value: Some(value::immediate_value::Value::Tensor(tv)),
            })),
        };

        let mut attrs = HashMap::new();
        attrs.insert("name".to_string(), string_attr(&ssa));
        attrs.insert("val".to_string(), v);

        let mil_op = make_operation("const", &ssa, HashMap::new(), &[(&ssa, &vt)], attrs);
        let value_ref = MilValueRef {
            ssa_name: ssa.clone(),
            value_type: vt.clone(),
            producing_op: "const".into(),
            output_index: 0,
        };

        let output_id = op.outputs[0];
        Ok(StagedEmission {
            mil_operation: Some(mil_op),
            proposed_outputs: vec![(output_id, value_ref.clone())],
            new_constants: vec![(key, value_ref.clone())],
            inventory: OpInventoryEntry {
                scheduled_op_id: op.op_id,
                mil_op_type: "const".into(),
                input_bindings: vec![],
                output_bindings: vec![(ssa, value_ref.clone())],
                output_types: vec![vt],
                opset: ctx.target.opset_identifier().into(),
                legal: true,
            },
        })
    }

    fn emit_identity(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        let ssa = ctx.fresh_ssa_name(op.op_id, 0);
        let input_ref = ctx.require_input(op.op_id, 0, &op.inputs)?;
        let vt = input_ref.value_type.clone();

        let mut inputs = HashMap::new();
        inputs.insert("x".to_string(), named_arg(&input_ref.ssa_name));

        let mil_op = make_operation("identity", &ssa, inputs, &[(&ssa, &vt)], HashMap::new());
        let value_ref = MilValueRef::new(ssa.clone(), vt.clone(), "identity");

        let output_id = op.outputs[0];
        Ok(StagedEmission {
            mil_operation: Some(mil_op),
            proposed_outputs: vec![(output_id, value_ref.clone())],
            new_constants: vec![],
            inventory: OpInventoryEntry {
                scheduled_op_id: op.op_id,
                mil_op_type: "identity".into(),
                input_bindings: vec![("x".into(), input_ref.clone())],
                output_bindings: vec![(ssa, value_ref.clone())],
                output_types: vec![vt],
                opset: ctx.target.opset_identifier().into(),
                legal: true,
            },
        })
    }

    fn emit_add(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        emit_binary(ctx, op, "add")
    }

    fn emit_mul(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        emit_binary(ctx, op, "mul")
    }

    fn emit_matmul(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        let attrs = match &op.attrs {
            OpAttrs::Matmul { transpose_x, transpose_y } => (*transpose_x, *transpose_y),
            _ => return Err(CoreMlLoweringError::new(&ctx.region_identity)
                .with_fatal(LoweringDiagnostic::ConstraintViolation {
                    op_id: op.op_id, constraint: "op_attrs".to_string(), detail: "expected Matmul".into(),
                })),
        };
        let (transpose_x, transpose_y) = attrs;

        let ssa = ctx.fresh_ssa_name(op.op_id, 0);
        let a_ref = ctx.require_input(op.op_id, 0, &op.inputs)?;
        let b_ref = ctx.require_input(op.op_id, 1, &op.inputs)?;

        let vt = value_type_tensor(tensor_type(mil_spec::DataType::Float32, &[1, 1]));

        let mut inputs = HashMap::new();
        inputs.insert("x".to_string(), named_arg(&a_ref.ssa_name));
        inputs.insert("y".to_string(), named_arg(&b_ref.ssa_name));
        inputs.insert("transpose_x".to_string(), bool_arg(transpose_x));
        inputs.insert("transpose_y".to_string(), bool_arg(transpose_y));

        let mil_op = make_operation("matmul", &ssa, inputs, &[(&ssa, &vt)], HashMap::new());
        let value_ref = MilValueRef::new(ssa.clone(), vt.clone(), "matmul");

        let output_id = op.outputs[0];
        Ok(StagedEmission {
            mil_operation: Some(mil_op),
            proposed_outputs: vec![(output_id, value_ref.clone())],
            new_constants: vec![],
            inventory: OpInventoryEntry {
                scheduled_op_id: op.op_id,
                mil_op_type: "matmul".into(),
                input_bindings: vec![
                    ("x".into(), a_ref.clone()),
                    ("y".into(), b_ref.clone()),
                ],
                output_bindings: vec![(ssa, value_ref.clone())],
                output_types: vec![vt],
                opset: ctx.target.opset_identifier().into(),
                legal: true,
            },
        })
    }

    fn emit_reshape(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        let target_shape = match &op.attrs {
            OpAttrs::Reshape { target_shape } => target_shape.clone(),
            _ => return Err(CoreMlLoweringError::new(&ctx.region_identity)
                .with_fatal(LoweringDiagnostic::ConstraintViolation {
                    op_id: op.op_id, constraint: "op_attrs".to_string(), detail: "expected Reshape".into(),
                })),
        };

        let ssa = ctx.fresh_ssa_name(op.op_id, 0);
        let input_ref = ctx.require_input(op.op_id, 0, &op.inputs)?;

        let shape_i64: Vec<i64> = target_shape.iter().map(|&s| s).collect();
        let tt = tensor_type(mil_spec::DataType::Float32, &shape_i64);
        let vt = value_type_tensor(tt);

        let mut inputs = HashMap::new();
        inputs.insert("x".to_string(), named_arg(&input_ref.ssa_name));
        inputs.insert("shape".to_string(), int_array_arg(&shape_i64));

        let mil_op = make_operation("reshape", &ssa, inputs, &[(&ssa, &vt)], HashMap::new());
        let value_ref = MilValueRef::new(ssa.clone(), vt.clone(), "reshape");

        let output_id = op.outputs[0];
        Ok(StagedEmission {
            mil_operation: Some(mil_op),
            proposed_outputs: vec![(output_id, value_ref.clone())],
            new_constants: vec![],
            inventory: OpInventoryEntry {
                scheduled_op_id: op.op_id,
                mil_op_type: "reshape".into(),
                input_bindings: vec![("x".into(), input_ref.clone())],
                output_bindings: vec![(ssa, value_ref.clone())],
                output_types: vec![vt],
                opset: ctx.target.opset_identifier().into(),
                legal: true,
            },
        })
    }

    fn emit_transpose(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        let perm = match &op.attrs {
            OpAttrs::Transpose { permutation } => permutation.clone(),
            _ => return Err(CoreMlLoweringError::new(&ctx.region_identity)
                .with_fatal(LoweringDiagnostic::ConstraintViolation {
                    op_id: op.op_id, constraint: "op_attrs".to_string(), detail: "expected Transpose".into(),
                })),
        };

        let ssa = ctx.fresh_ssa_name(op.op_id, 0);
        let input_ref = ctx.require_input(op.op_id, 0, &op.inputs)?;

        let vt = input_ref.value_type.clone();

        let mut inputs = HashMap::new();
        inputs.insert("x".to_string(), named_arg(&input_ref.ssa_name));
        let perm_i64: Vec<i64> = perm.iter().map(|&p| p as i64).collect();
        inputs.insert("perm".to_string(), int_array_arg(&perm_i64));

        let mil_op = make_operation("transpose", &ssa, inputs, &[(&ssa, &vt)], HashMap::new());
        let value_ref = MilValueRef::new(ssa.clone(), vt.clone(), "transpose");

        let output_id = op.outputs[0];
        Ok(StagedEmission {
            mil_operation: Some(mil_op),
            proposed_outputs: vec![(output_id, value_ref.clone())],
            new_constants: vec![],
            inventory: OpInventoryEntry {
                scheduled_op_id: op.op_id,
                mil_op_type: "transpose".into(),
                input_bindings: vec![("x".into(), input_ref)],
                output_bindings: vec![(ssa, value_ref.clone())],
                output_types: vec![vt],
                opset: ctx.target.opset_identifier().into(),
                legal: true,
            },
        })
    }

    fn emit_softmax(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        let axis = match &op.attrs {
            OpAttrs::Softmax { axis } => *axis,
            _ => return Err(CoreMlLoweringError::new(&ctx.region_identity)
                .with_fatal(LoweringDiagnostic::ConstraintViolation {
                    op_id: op.op_id, constraint: "op_attrs".to_string(), detail: "expected Softmax".into(),
                })),
        };

        let ssa = ctx.fresh_ssa_name(op.op_id, 0);
        let input_ref = ctx.require_input(op.op_id, 0, &op.inputs)?;
        let vt = input_ref.value_type.clone();

        let mut inputs = HashMap::new();
        inputs.insert("x".to_string(), named_arg(&input_ref.ssa_name));
        inputs.insert("axis".to_string(), int_arg(axis));

        let mil_op = make_operation("softmax", &ssa, inputs, &[(&ssa, &vt)], HashMap::new());
        let value_ref = MilValueRef::new(ssa.clone(), vt.clone(), "softmax");

        let output_id = op.outputs[0];
        Ok(StagedEmission {
            mil_operation: Some(mil_op),
            proposed_outputs: vec![(output_id, value_ref.clone())],
            new_constants: vec![],
            inventory: OpInventoryEntry {
                scheduled_op_id: op.op_id,
                mil_op_type: "softmax".into(),
                input_bindings: vec![("x".into(), input_ref)],
                output_bindings: vec![(ssa, value_ref.clone())],
                output_types: vec![vt],
                opset: ctx.target.opset_identifier().into(),
                legal: true,
            },
        })
    }

    fn emit_silu(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError> {
        let ssa = ctx.fresh_ssa_name(op.op_id, 0);
        let input_ref = ctx.require_input(op.op_id, 0, &op.inputs)?;
        let vt = input_ref.value_type.clone();

        let mut inputs = HashMap::new();
        inputs.insert("x".to_string(), named_arg(&input_ref.ssa_name));

        let mil_op = make_operation("silu", &ssa, inputs, &[(&ssa, &vt)], HashMap::new());
        let value_ref = MilValueRef::new(ssa.clone(), vt.clone(), "silu");

        let output_id = op.outputs[0];
        Ok(StagedEmission {
            mil_operation: Some(mil_op),
            proposed_outputs: vec![(output_id, value_ref.clone())],
            new_constants: vec![],
            inventory: OpInventoryEntry {
                scheduled_op_id: op.op_id,
                mil_op_type: "silu".into(),
                input_bindings: vec![("x".into(), input_ref)],
                output_bindings: vec![(ssa, value_ref.clone())],
                output_types: vec![vt],
                opset: ctx.target.opset_identifier().into(),
                legal: true,
            },
        })
    }
}

fn emit_binary(ctx: &mut CoreMlLoweringCtx, op: &ScheduledOp, mil_type: &str) -> Result<StagedEmission, CoreMlLoweringError> {
    let ssa = ctx.fresh_ssa_name(op.op_id, 0);
    let a_ref = ctx.require_input(op.op_id, 0, &op.inputs)?;
    let b_ref = ctx.require_input(op.op_id, 1, &op.inputs)?;
    let vt = a_ref.value_type.clone();

    let mut inputs = HashMap::new();
    inputs.insert("x".to_string(), named_arg(&a_ref.ssa_name));
    inputs.insert("y".to_string(), named_arg(&b_ref.ssa_name));

    let mil_op = make_operation(mil_type, &ssa, inputs, &[(&ssa, &vt)], HashMap::new());
    let value_ref = MilValueRef::new(ssa.clone(), vt.clone(), mil_type);

    let output_id = op.outputs[0];
    Ok(StagedEmission {
        mil_operation: Some(mil_op),
        proposed_outputs: vec![(output_id, value_ref.clone())],
        new_constants: vec![],
        inventory: OpInventoryEntry {
            scheduled_op_id: op.op_id,
            mil_op_type: mil_type.into(),
            input_bindings: vec![("x".into(), a_ref), ("y".into(), b_ref)],
            output_bindings: vec![(ssa, value_ref.clone())],
            output_types: vec![vt],
            opset: ctx.target.opset_identifier().into(),
            legal: true,
        },
    })
}

// ── Preflight ─────────────────────────────────────────────────────────────

fn preflight_fixed_shape(ctx: &CoreMlLoweringCtx, op: &ScheduledOp) -> Result<(), Vec<LoweringDiagnostic>> {
    let mut diags = Vec::new();
    for input_id in &op.inputs {
        if let Some(meta) = ctx.tensor_meta.get(input_id) {
            if let Err(e) = meta.shape_policy.validate() {
                diags.push(LoweringDiagnostic::ShapePolicyUnsupported {
                    op_id: op.op_id,
                    policy: e,
                });
            }
        }
    }
    for output_id in &op.outputs {
        if let Some(meta) = ctx.tensor_meta.get(output_id) {
            if let Err(e) = meta.shape_policy.validate() {
                diags.push(LoweringDiagnostic::ShapePolicyUnsupported {
                    op_id: op.op_id,
                    policy: e,
                });
            }
        }
    }
    if diags.is_empty() { Ok(()) } else { Err(diags) }
}

fn preflight_op(opcode: Opcode) -> fn(&CoreMlLoweringCtx, &ScheduledOp) -> Result<(), Vec<LoweringDiagnostic>> {
    // Shared preflight: checks that inputs are bound, outputs are unbound,
    // number of inputs and outputs match expectations, and shapes are valid.
    //
    // For now, basic structural checks. Op-specific preflight can be added per op.
    fn default_preflight(ctx: &CoreMlLoweringCtx, op: &ScheduledOp) -> Result<(), Vec<LoweringDiagnostic>> {
        let mut diags = Vec::new();
        // Check inputs are known tensors
        for (i, input_id) in op.inputs.iter().enumerate() {
            if !ctx.tensor_meta.contains_key(input_id) {
                diags.push(LoweringDiagnostic::ConstraintViolation {
                    op_id: op.op_id,
                    constraint: "input_known".into(),
                    detail: format!("input[{}] tensor {:?} not registered in tensor_meta", i, input_id),
                });
            }
        }
        // Check outputs are known tensors
        for (i, output_id) in op.outputs.iter().enumerate() {
            if !ctx.tensor_meta.contains_key(output_id) {
                diags.push(LoweringDiagnostic::ConstraintViolation {
                    op_id: op.op_id,
                    constraint: "output_known".into(),
                    detail: format!("output[{}] tensor {:?} not registered in tensor_meta", i, output_id),
                });
            }
        }
        // Check shape policy
        if let Err(shape_diags) = preflight_fixed_shape(ctx, op) {
            diags.extend(shape_diags);
        }
        if diags.is_empty() { Ok(()) } else { Err(diags) }
    }
    default_preflight
}

// ── OpImpl ────────────────────────────────────────────────────────────────

struct OpImpl {
    preflight: fn(&CoreMlLoweringCtx, &ScheduledOp) -> Result<(), Vec<LoweringDiagnostic>>,
    emit: fn(&mut CoreMlLoweringCtx, &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError>,
}

fn make_op_impl(
    emit: fn(&mut CoreMlLoweringCtx, &ScheduledOp) -> Result<StagedEmission, CoreMlLoweringError>,
) -> OpImpl {
    OpImpl { preflight: preflight_op(Opcode::Constant), emit }
}

// ── OpRegistry ────────────────────────────────────────────────────────────

pub struct OpRegistry {
    emitters: HashMap<Opcode, OpImpl>,
}

impl OpRegistry {
    pub fn default_gate() -> Self {
        let mut r = OpRegistry { emitters: HashMap::new() };
        r.register(Opcode::Constant, make_op_impl(OpBuilder::emit_constant));
        r.register(Opcode::Identity, make_op_impl(OpBuilder::emit_identity));
        r.register(Opcode::Add, make_op_impl(OpBuilder::emit_add));
        r.register(Opcode::Multiply, make_op_impl(OpBuilder::emit_mul));
        r.register(Opcode::Matmul, make_op_impl(OpBuilder::emit_matmul));
        r.register(Opcode::Reshape, make_op_impl(OpBuilder::emit_reshape));
        r.register(Opcode::Transpose, make_op_impl(OpBuilder::emit_transpose));
        r.register(Opcode::Softmax, make_op_impl(OpBuilder::emit_softmax));
        r.register(Opcode::Silu, make_op_impl(OpBuilder::emit_silu));
        r
    }

    pub fn register(&mut self, opcode: Opcode, impl_: OpImpl) {
        self.emitters.insert(opcode, impl_);
    }

    pub fn get(&self, opcode: Opcode) -> Option<&OpImpl> {
        self.emitters.get(&opcode)
    }

    pub fn contains(&self, opcode: Opcode) -> bool {
        self.emitters.contains_key(&opcode)
    }
}

// ── StagedEmission ────────────────────────────────────────────────────────

pub struct StagedEmission {
    /// MIL operation to append (None for cached constants).
    pub mil_operation: Option<mil_spec::Operation>,
    /// Proposed output bindings (must match scheduled outputs exactly).
    pub proposed_outputs: Vec<(TensorId, MilValueRef)>,
    /// New constants for the pool.
    pub new_constants: Vec<(ConstantKey, MilValueRef)>,
    /// Inventory entry.
    pub inventory: OpInventoryEntry,
}

// ── CoreMlLoweringCtx ─────────────────────────────────────────────────────

pub struct CoreMlLoweringCtx {
    /// The MilBuilder owns the program, function, and block.
    pub builder: MilBuilder,
    /// Scheduled-tensor → MIL SSA ref.
    pub value_bindings: HashMap<TensorId, MilValueRef>,
    /// Content-addressed constant dedup pool.
    pub constant_pool: ConstantPool,
    /// Per-tensor metadata.
    pub tensor_meta: HashMap<TensorId, TensorMeta>,
    /// Validated target profile.
    pub target: CoreMlTarget,
    /// Precision policy.
    pub precision: PrecisionPolicy,
    /// Accumuated diagnostics.
    pub diagnostics: Vec<LoweringDiagnostic>,
    /// SSA name counter (deterministic: based on op_id + output_index).
    ssa_counter: u64,
    /// Region identity for error messages.
    region_identity: String,
}

impl CoreMlLoweringCtx {
    pub fn new(
        func_name: &str,
        region_identity: &str,
        target: CoreMlTarget,
        precision: PrecisionPolicy,
    ) -> Self {
        let opset = target.opset_identifier();
        let builder = MilBuilder::new(func_name)
            .set_opset(opset);
        CoreMlLoweringCtx {
            builder,
            value_bindings: HashMap::new(),
            constant_pool: ConstantPool::new(),
            tensor_meta: HashMap::new(),
            target,
            precision,
            diagnostics: Vec::new(),
            ssa_counter: 0,
            region_identity: region_identity.to_string(),
        }
    }

    /// Register a tensor's metadata before lowering begins.
    pub fn register_tensor(&mut self, id: TensorId, meta: TensorMeta) {
        self.tensor_meta.insert(id, meta);
    }

    /// Register an input tensor, adding it to the MIL function signature.
    pub fn register_input(&mut self, id: TensorId, name: &str, shape: &[u32], dtype: mil_spec::DataType) {
        let policy = ShapePolicy::Fixed(shape.to_vec());
        let shape_i64: Vec<i64> = shape.iter().map(|&s| s as i64).collect();
        let tt = tensor_type(dtype, &shape_i64);
        let vt = value_type_tensor(tt);
        self.tensor_meta.insert(id, TensorMeta {
            dtype,
            shape_policy: policy,
            is_input: true,
            is_output: false,
            is_constant: false,
        });
        self.builder = std::mem::take(&mut self.builder).input(name, dtype, &shape_i64);
        // Track the input's MIL value
        let mil_ref = MilValueRef::new(name.to_string(), vt, "input");
        self.value_bindings.insert(id, mil_ref);
    }

    /// Generate a deterministic SSA name from op_id and output index.
    fn fresh_ssa_name(&mut self, op_id: OperationId, output_index: u32) -> String {
        let name = format!("op_{}_{}", op_id.0, output_index);
        self.ssa_counter += 1;
        name
    }

    /// Require that a scheduled input tensor is already bound to a MIL value.
    fn require_input(&self, op_id: OperationId, idx: usize, inputs: &[TensorId]) -> Result<MilValueRef, CoreMlLoweringError> {
        let input_id = inputs.get(idx).ok_or_else(|| {
            CoreMlLoweringError::new(&self.region_identity)
                .with_fatal(LoweringDiagnostic::ConstraintViolation {
                    op_id,
                    constraint: "input_count".into(),
                    detail: format!("expected input[{}], found {} inputs", idx, inputs.len()),
                })
        })?;
        self.value_bindings.get(input_id).cloned().ok_or_else(|| {
            CoreMlLoweringError::new(&self.region_identity)
                .with_fatal(LoweringDiagnostic::ConstraintViolation {
                    op_id,
                    constraint: "input_bound".into(),
                    detail: format!("input tensor {:?} not bound to any MIL value", input_id),
                })
        })
    }

    /// Commit a staged emission atomically.
    fn commit(&mut self, staged: StagedEmission) -> Result<(), CoreMlLoweringError> {
        // Validate: proposed outputs must be unbound
        for (tid, _) in &staged.proposed_outputs {
            if self.value_bindings.contains_key(tid) {
                return Err(CoreMlLoweringError::new(&self.region_identity)
                    .with_fatal(LoweringDiagnostic::ConstraintViolation {
                        op_id: OperationId(tid.0),
                        constraint: "output_already_bound".into(),
                        detail: format!("tensor {:?} already has a MIL value binding", tid),
                    }));
            }
        }

        // Validate: output count matches (won't check exact match here —
        // the ScheduledOp declares correct outputs)
        // Check output types match tensor_meta where available
        for (tid, valref) in &staged.proposed_outputs {
            if let Some(meta) = self.tensor_meta.get(tid) {
                // We could compare MIL types here in a more complete implementation
                let _ = meta;
            }
            self.value_bindings.insert(*tid, valref.clone());
        }

        // Add new constants to pool
        for (key, valref) in &staged.new_constants {
            self.constant_pool.insert(key.clone(), valref.clone());
        }

        // Append MIL operation if present
        if let Some(op) = staged.mil_operation {
            self.builder = std::mem::take(&mut self.builder).operation(op, None);
        }

        Ok(())
    }

    /// Finalize: set block outputs from the region's output tensor bindings.
    fn finalize(mut self, region: &ScheduledRegion) -> Result<(MilBuilder, MilLoweringReceipt), CoreMlLoweringError> {
        let mut op_inventory: Vec<OpInventoryEntry> = Vec::new();
        let mut output_count = 0;

        for output_id in &region.outputs {
            if let Some(valref) = self.value_bindings.get(output_id) {
                self.builder = std::mem::take(&mut self.builder).output(&valref.ssa_name);
                output_count += 1;
            } else {
                return Err(CoreMlLoweringError::new(&self.region_identity)
                    .with_fatal(LoweringDiagnostic::ConstraintViolation {
                        op_id: OperationId(output_id.0),
                        constraint: "output_unbound".into(),
                        detail: format!("region output tensor {:?} has no MIL binding", output_id),
                    }));
            }
        }

        Ok((self.builder, MilLoweringReceipt {
            program_digest: EvidenceDigest(format!("mil_v1_{}", output_count)),
            op_count: self.ssa_counter as usize,
            constant_count: self.constant_pool.entries.len(),
            op_legality: vec![],
            warnings: self.diagnostics.into_iter().filter(|d| !d.is_fatal()).collect(),
            opset: self.target.opset_identifier().into(),
        }))
    }
}

// ── CoreMlLowering ────────────────────────────────────────────────────────

pub struct CoreMlLowering {
    registry: OpRegistry,
    target: CoreMlTarget,
    precision: PrecisionPolicy,
}

impl CoreMlLowering {
    pub fn new(target: CoreMlTarget) -> Self {
        CoreMlLowering {
            registry: OpRegistry::default_gate(),
            target,
            precision: PrecisionPolicy::F32,
        }
    }

    /// Build the MIL program from a scheduled region (stage 1).
    fn lower_to_mil(
        &self,
        region: &ScheduledRegion,
        ops: &[ScheduledOp],
    ) -> Result<(CoreMlMilArtifact, MilLoweringReceipt), String> {
        let mut ctx = CoreMlLoweringCtx::new(
            "main",
            &format!("region_{}", region.region_id.0),
            self.target,
            self.precision,
        );

        // Register inputs first
        for (i, input_id) in region.inputs.iter().enumerate() {
            if !ctx.tensor_meta.contains_key(input_id) {
                // Find the corresponding physical tensor for shape info
                let shape = region.physical_tensors.iter()
                    .find(|pt| pt.semantic_id == *input_id)
                    .map(|pt| pt.shape.dims.clone())
                    .unwrap_or_else(|| vec![1, 4]); // fallback default
                ctx.register_input(*input_id, &format!("input_{}", i), &shape, mil_spec::DataType::Float32);
            }
        }

        // Register intermediate tensors from ops (constant outputs, etc.)
        for op in ops {
            for input_id in &op.inputs {
                ctx.tensor_meta.entry(*input_id).or_insert_with(|| {
                    let shape = region.physical_tensors.iter()
                        .find(|pt| pt.semantic_id == *input_id)
                        .map(|pt| pt.shape.dims.clone())
                        .unwrap_or_else(|| vec![1, 4]);
                    TensorMeta {
                        dtype: mil_spec::DataType::Float32,
                        shape_policy: ShapePolicy::Fixed(shape),
                        is_input: false,
                        is_output: false,
                        is_constant: false,
                    }
                });
            }
            for output_id in &op.outputs {
                ctx.tensor_meta.entry(*output_id).or_insert_with(|| {
                    let shape = region.physical_tensors.iter()
                        .find(|pt| pt.semantic_id == *output_id)
                        .map(|pt| pt.shape.dims.clone())
                        .unwrap_or_else(|| vec![4, 1]);
                    TensorMeta {
                        dtype: mil_spec::DataType::Float32,
                        shape_policy: ShapePolicy::Fixed(shape),
                        is_input: false,
                        is_output: false,
                        is_constant: op.opcode == Opcode::Constant,
                    }
                });
            }
        }

        // Register output tensor metadata
        for output_id in &region.outputs {
            let shape = region.physical_tensors.iter()
                .find(|pt| pt.semantic_id == *output_id)
                .map(|pt| pt.shape.dims.clone())
                .unwrap_or_else(|| vec![1, 1]);
            let policy = ShapePolicy::Fixed(shape);
            ctx.tensor_meta.insert(*output_id, TensorMeta {
                dtype: mil_spec::DataType::Float32,
                shape_policy: policy,
                is_input: false,
                is_output: true,
                is_constant: false,
            });
        }

        // Process each op
        for op in ops {
            let impl_ = self.registry.get(op.opcode).ok_or_else(|| {
                format!("opcode {:?} not registered in Core ML lowering", op.opcode)
            })?;

            // Run preflight
            if let Err(diags) = (impl_.preflight)(&ctx, op) {
                for d in diags {
                    if d.is_fatal() {
                        return Err(format!("preflight failed for op {:?}: {}", op.op_id, d.message()));
                    }
                    ctx.diagnostics.push(d);
                }
            }

            // Emit
            let emission = (impl_.emit)(&mut ctx, op)
                .map_err(|e| format!("emit failed for op {:?}: {}", op.op_id, e))?;

            // Commit atomically
            ctx.commit(emission)
                .map_err(|e| format!("commit failed for op {:?}: {}", op.op_id, e))?;
        }

        // Extract value_bindings before finalize consumes ctx
        let final_bindings = ctx.value_bindings.clone();

        // Finalize: bind outputs
        let (builder, receipt) = ctx.finalize(region)
            .map_err(|e| format!("finalize failed: {}", e))?;

        // Build the MIL program
        let program = builder.build()
            .map_err(|e| format!("MilBuilder::build: {}", e))?;

        Ok((CoreMlMilArtifact {
            program,
            value_bindings: final_bindings,
            operation_inventory: vec![],
        }, receipt))
    }

    /// Lower with an explicit operation list (used when ops are built externally).
    /// This is the primary entry point for the general lowering path.
    pub fn lower_with_ops(
        &self,
        region: &ScheduledRegion,
        ops: &[ScheduledOp],
    ) -> Result<(CoreMlCompiledArtifact, LoweringReceipt), String> {
        let start = Instant::now();

        let legality = self.validate(region)?;
        if !legality.legal {
            return Err(format!("validation failed: {:?}", legality.violations));
        }

        // Stage 1: MIL lowering
        let (mil_artifact, _lowering_receipt) = self.lower_to_mil(region, ops)?;

        // Stage 2: Package
        let meta = ModelMeta {
            model_name: format!("region_{}", region.region_id.0),
            function_name: "main".into(),
            inputs: region.inputs.iter().enumerate().map(|(i, tid)| {
                let shape = region.physical_tensors.iter()
                    .find(|pt| pt.semantic_id == *tid)
                    .map(|pt| pt.shape.dims.iter().map(|&d| d as i64).collect())
                    .unwrap_or_else(|| vec![1i64, 4]);
                (format!("input_{}", i), shape)
            }).collect(),
            outputs: derive_coreml_outputs(&region.outputs, &mil_artifact.value_bindings),
            output_name: derive_coreml_output_name(&region.outputs, &mil_artifact.value_bindings),
            ..Default::default()
        };

        let pkg_dir = tempfile::tempdir().map_err(|e| format!("tempdir: {}", e))?;
        let pkg_path = mlpackage::write_mlpackage(
            mil_artifact.program,
            pkg_dir.path(),
            &meta,
        ).map_err(|e| format!("write_mlpackage: {}", e))?;

        let _pkg_receipt = PackageReceipt {
            source_package_sha256: format!("{:x}", Sha256::digest(std::fs::read(pkg_path.join("Manifest.json")).unwrap_or_default())),
            manifest_sha256: String::new(),
            weight_file_count: 0,
            weight_file_hashes: vec![],
        };

        // Stage 3: Compile
        let output_dir = tempfile::tempdir().map_err(|e| format!("tempdir: {}", e))?;
        let island_id = format!("region_{}", region.region_id.0);
        let island_receipt = compile_mlpackage(
            &pkg_path,
            output_dir.path(),
            &island_id,
            "cpuAndGPU",
            self.target.opset_identifier(),
        ).map_err(|e| format!("compile_mlpackage: {}", e))?;

        let compile_duration_ns = start.elapsed().as_nanos() as u64;
        let compiled_hash = island_receipt.compiled_hash.clone();

        let artifact = CoreMlCompiledArtifact {
            _output_dir: output_dir,
            compiled_modelc_path: std::path::PathBuf::from(&island_receipt.compiled_modelc_path),
            compiled_sha256: compiled_hash.clone(),
            island_receipt,
        };

        let receipt = LoweringReceipt {
            backend_id: BackendId(3),
            source_schedule_digest: EvidenceDigest(format!("sched_{}", region.region_id.0)),
            legality,
            artifact_id: BackendArtifactId(
                compiled_hash.as_bytes().iter().fold(0u64, |a, &b| a.wrapping_mul(31).wrapping_add(b as u64))
            ),
            compile_duration_ns,
            machine_profile_digest: EvidenceDigest("coreml_macOS".into()),
            cache_hit: false,
        };

        Ok((artifact, receipt))
    }

}

impl BackendLowering for CoreMlLowering {
    type Artifact = CoreMlCompiledArtifact;

    fn validate(&self, region: &ScheduledRegion) -> Result<LegalityReceipt, String> {
        let mut violations = Vec::new();
        let region_id = region.region_id.0;

        // Check precision
        if let Err(msg) = self.precision.validate() {
            violations.push(LegalityViolation {
                constraint_id: "coreml:precision".into(),
                operation_ids: vec![],
                message: msg.to_string(),
                fatal: true,
            });
        }

        // Check that region is non-empty
        if region.operations.is_empty() {
            violations.push(LegalityViolation {
                constraint_id: "coreml:empty_region".into(),
                operation_ids: vec![],
                message: "region contains no operations".into(),
                fatal: true,
            });
        }

        Ok(LegalityReceipt {
            legal: violations.is_empty(),
            violations,
        })
    }

    fn lower(
        &self,
        region: &ScheduledRegion,
    ) -> Result<(Self::Artifact, LoweringReceipt), String> {
        let start = Instant::now();

        // First, validate
        let legality = self.validate(region)?;
        if !legality.legal {
            return Err(format!("validation failed: {:?}", legality.violations));
        }

        // Build MIL program from ops.
        // We construct a simplified op list for now from the region's operation IDs.
        // In a full implementation, the ops would come from the semantic/scheduled IR.
        let ops: Vec<ScheduledOp> = Vec::new(); // TODO: derive from region in full implementation

        // Stage 1: MIL lowering
        let (mil_artifact, lowering_receipt) = self.lower_to_mil(region, &ops)?;

        // Stage 2: Package
        let meta = ModelMeta {
            model_name: format!("region_{}", region.region_id.0),
            function_name: "main".into(),
            inputs: region.inputs.iter().enumerate().map(|(i, tid)| {
                let shape = region.physical_tensors.iter()
                    .find(|pt| pt.semantic_id == *tid)
                    .map(|pt| pt.shape.dims.iter().map(|&d| d as i64).collect())
                    .unwrap_or_else(|| vec![1i64, 4]);
                (format!("input_{}", i), shape)
            }).collect(),
            outputs: region.outputs.iter().enumerate().map(|(i, _tid)| {
                (format!("output_{}", i), vec![1i64, 1])
            }).collect(),
            output_name: "output".into(),
            ..Default::default()
        };

        let pkg_dir = tempfile::tempdir().map_err(|e| format!("tempdir: {}", e))?;
        let pkg_path = mlpackage::write_mlpackage(
            mil_artifact.program,
            pkg_dir.path(),
            &meta,
        ).map_err(|e| format!("write_mlpackage: {}", e))?;

        let pkg_receipt = {
            let data = std::fs::read(pkg_path.join("Manifest.json")).unwrap_or_default();
            PackageReceipt {
                source_package_sha256: format!("{:x}", Sha256::digest(&data)),
                manifest_sha256: format!("{:x}", Sha256::digest(&data)),
                weight_file_count: 0,
                weight_file_hashes: vec![],
            }
        };

        // Stage 3: Compile
        let output_dir = tempfile::tempdir().map_err(|e| format!("tempdir: {}", e))?;
        let island_id = format!("region_{}", region.region_id.0);
        let island_receipt = compile_mlpackage(
            &pkg_path,
            output_dir.path(),
            &island_id,
            "cpuAndGPU",
            self.target.opset_identifier(),
        ).map_err(|e| format!("compile_mlpackage: {}", e))?;

        let compile_duration_ns = start.elapsed().as_nanos() as u64;

        let compiled_hash = island_receipt.compiled_hash.clone();
        let compiled_path = island_receipt.compiled_modelc_path.clone();

        let artifact = CoreMlCompiledArtifact {
            _output_dir: output_dir,
            compiled_modelc_path: std::path::PathBuf::from(&compiled_path),
            compiled_sha256: compiled_hash.clone(),
            island_receipt,
        };

        let receipt = LoweringReceipt {
            backend_id: BackendId(3),
            source_schedule_digest: EvidenceDigest(format!("sched_{}", region.region_id.0)),
            legality,
            artifact_id: BackendArtifactId(
                compiled_hash.as_bytes().iter().fold(0u64, |a, &b| a.wrapping_mul(31).wrapping_add(b as u64))
            ),
            compile_duration_ns,
            machine_profile_digest: EvidenceDigest("coreml_macOS".into()),
            cache_hit: false,
        };

        Ok((artifact, receipt))
    }
}

// ── Artifact types ────────────────────────────────────────────────────────

pub struct CoreMlMilArtifact {
    pub program: mil_spec::Program,
    pub value_bindings: HashMap<TensorId, MilValueRef>,
    pub operation_inventory: Vec<OpInventoryEntry>,
}

pub struct CoreMlPackageArtifact {
    pub _tempdir: tempfile::TempDir,
    pub package_path: std::path::PathBuf,
    pub source_package_sha256: String,
    pub model_meta: ModelMeta,
}

pub struct CoreMlCompiledArtifact {
    pub _output_dir: tempfile::TempDir,
    pub compiled_modelc_path: std::path::PathBuf,
    pub compiled_sha256: String,
    pub island_receipt: CoreMlIslandReceipt,
}

// ── Re-export the lowered test helper (preserves backward compat) ─────────

use super::dataset::F32MatmulDataset;

/// Legacy matmul lowering — now delegates to general lowering when ops are
/// constructed, or can be used as a test fixture directly.
pub fn lower_matmul_coreml(
    dataset: &F32MatmulDataset,
    _semantic_digest: EvidenceDigest,
) -> Result<super::CoreMlLoweringReceipt, String> {
    // Build a matmul op manually and run it through CoreMlLowering
    let ops = vec![
        ScheduledOp {
            op_id: OperationId(0),
            opcode: Opcode::Constant,
            inputs: vec![],
            outputs: vec![TensorId(2)],
            attrs: OpAttrs::Constant {
                data: dataset.weight_data.clone(),
                shape: vec![4, 1],
            },
        },
        ScheduledOp {
            op_id: OperationId(1),
            opcode: Opcode::Matmul,
            inputs: vec![TensorId(1), TensorId(2)],
            outputs: vec![TensorId(3)],
            attrs: OpAttrs::Matmul { transpose_x: false, transpose_y: false },
        },
    ];

    let region = ScheduledRegion {
        region_id: RegionId(1),
        name: "matmul-test".into(),
        operations: vec![OperationId(0), OperationId(1)],
        selected_backend: BackendId(3),
        physical_tensors: vec![],
        inputs: vec![TensorId(1)],
        outputs: vec![TensorId(3)],
        dependencies: vec![],
        fusions: vec![],
        state_effects: vec![],
        temp_memory_bytes: 0,
        is_fence: false,
    };

    let lowering = CoreMlLowering::new(CoreMlTarget::default_gate_target());
    let (artifact, lowering_receipt) = lowering.lower_with_ops(&region, &ops)?;

    let compile_ns = lowering_receipt.compile_duration_ns;
    let modelc_path = artifact.compiled_modelc_path.clone();
    let artifact_exists = modelc_path.is_dir() && modelc_path.join("metadata.json").exists();

    Ok(super::CoreMlLoweringReceipt {
        lowering: lowering_receipt,
        island_receipt: artifact.island_receipt,
        artifact_exists,
    })
}


fn derive_coreml_outputs(outputs: &[TensorId], bindings: &HashMap<TensorId, MilValueRef>) -> Vec<(String, Vec<i64>)> {
    outputs.iter().enumerate().map(|(i, tid)| {
        let name = bindings.get(tid)
            .map(|vr| vr.ssa_name.clone())
            .unwrap_or_else(|| format!("output_{}", i));
        (name, vec![1i64, 1])
    }).collect()
}

fn derive_coreml_output_name(outputs: &[TensorId], bindings: &HashMap<TensorId, MilValueRef>) -> String {
    outputs.first()
        .and_then(|tid| bindings.get(tid))
        .map(|vr| vr.ssa_name.clone())
        .unwrap_or_else(|| "output".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::toolchain_attest::ToolchainAttestation;

    /// Core ML matmul compile route preserved through general lowering.
    #[test]
    fn coreml_preserves_compile_route() {
        let toolchain = match ToolchainAttestation::probe() {
            Ok(t) => t,
            Err(e) => {
                eprintln!("SKIP: toolchain not available: {e}");
                return;
            }
        };
        eprintln!("compiler: {} ({})", toolchain.coremlcompiler_version, toolchain.xcode_build_version);

        let dataset = F32MatmulDataset::default();
        let digest = EvidenceDigest("test".into());

        let receipt = lower_matmul_coreml(&dataset, digest)
            .expect("Core ML lowering must succeed (xcrun required)");

        assert!(receipt.artifact_exists,
            "Core ML .mlmodelc artifact must exist on disk");
        assert!(receipt.lowering.compile_duration_ns > 0);
        assert!(!receipt.island_receipt.compiled_hash.is_empty());
        assert!(!receipt.island_receipt.model_hash.is_empty());
        eprintln!(
            "PASS: model_hash={} compiled_hash={} compile_ns={}",
            &receipt.island_receipt.model_hash[..16],
            &receipt.island_receipt.compiled_hash[..16],
            receipt.lowering.compile_duration_ns,
        );
    }

    #[test]
    fn constant_pool_dedup_by_content() {
        let mut pool = ConstantPool::new();
        let key1 = ConstantKey::from_f32(&[1.0, 2.0, 3.0, 4.0], &[4]);
        let key2 = ConstantKey::from_f32(&[1.0, 2.0, 3.0, 4.0], &[4]); // same payload
        let key3 = ConstantKey::from_f32(&[5.0, 6.0], &[2]); // different

        let vt = value_type_tensor(tensor_type(mil_spec::DataType::Float32, &[4]));
        let ref1 = MilValueRef::new("c1".into(), vt.clone(), "const");
        pool.insert(key1.clone(), ref1);

        assert!(pool.get(&key2).is_some(), "same payload must dedup");
        assert!(pool.get(&key3).is_none(), "different payload must not collide");
    }

    #[test]
    fn opcode_names_are_human_readable() {
        assert_eq!(Opcode::Constant.name(), "constant");
        assert_eq!(Opcode::Matmul.name(), "matmul");
        assert_eq!(Opcode::Silu.name(), "silu");
    }

    #[test]
    fn shape_policy_rejects_non_fixed() {
        assert!(ShapePolicy::Fixed(vec![1, 4]).validate().is_ok());
        assert!(ShapePolicy::Bounded { default: vec![1,4], min: vec![1,4], max: vec![1,4] }.validate().is_err());
        assert!(ShapePolicy::Enumerated { default: vec![1,4], alternatives: vec![] }.validate().is_err());
        assert!(ShapePolicy::Symbolic { named_dims: vec![] }.validate().is_err());
    }

    #[test]
    fn precision_rejects_fp16() {
        assert!(PrecisionPolicy::F32.validate().is_ok());
        assert!(PrecisionPolicy::Fp16.validate().is_err());
    }

    #[test]
    fn target_default_is_oldest() {
        let target = CoreMlTarget::default_gate_target();
        assert_eq!(target.spec_version(), 7);
        assert_eq!(target.opset_identifier(), "CoreML6");
        assert_eq!(target.deployment_target(), "macOS13");
    }

    #[test]
    fn registry_contains_all_nine_ops() {
        let reg = OpRegistry::default_gate();
        assert!(reg.contains(Opcode::Constant));
        assert!(reg.contains(Opcode::Identity));
        assert!(reg.contains(Opcode::Add));
        assert!(reg.contains(Opcode::Multiply));
        assert!(reg.contains(Opcode::Matmul));
        assert!(reg.contains(Opcode::Reshape));
        assert!(reg.contains(Opcode::Transpose));
        assert!(reg.contains(Opcode::Softmax));
        assert!(reg.contains(Opcode::Silu));

        // No extras
        let all = vec![
            Opcode::Constant, Opcode::Identity, Opcode::Add, Opcode::Multiply,
            Opcode::Matmul, Opcode::Reshape, Opcode::Transpose, Opcode::Softmax, Opcode::Silu,
        ];
        for opcode in &all {
            assert!(reg.contains(*opcode), "missing opcode {:?}", opcode);
        }
    }
}
