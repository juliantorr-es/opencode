//! Core ML Minimal Reproducer — diagnostic graphs and structural verifier.
//!
//! Two tracks:
//! - Elementwise: sigmoid_only, add_input_input, add_input_const, mul_input_input,
//!   mul_input_const, sigmoid_mul
//! - Output-width: add_n2, matmul_n1, matmul_n2, branch_n1, branch_n2, multi_n1,
//!   multi_n2
//! - Auxiliary: identity (expected_harness_passthrough)
//!
//! Each graph has a `DiagnosticGraphContract` specifying expected structure.
//! `verify_graph_contract` validates the generated MIL program against the contract
//! before any compiler invocation.

use std::collections::HashMap;
use coreml_proto::proto::mil_spec::{self, argument, dimension, tensor_value, value};

use crate::mil_builder::{MilBuildError, MilBuilder, resolve_unary_op_type};

// ── Error types ───────────────────────────────────────────────────────────

/// Machine-readable error codes for structural verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationErrorCode {
    /// An output name in the contract is not in block outputs.
    MissingOutput,
    /// An output shape differs from the declared contract.
    WrongOutputShape,
    /// An op input references an undefined SSA value.
    UndefinedOpInput,
    /// The operation producing an output is not the expected op index/type.
    WrongOutputProducer,
    /// An intermediate value has no known type in the MIL value_type table.
    MissingValueType,
    /// A const tensor's element count does not match its declared shape.
    ConstLengthMismatch,
    /// A contract output name does not appear in any op outputs.
    OutputNameNotFoundInOps,
    /// Block output SSA name not found in the producer_map.
    UnmappedBlockOutput,
    /// Op index is out of range for the op_list.
    OpIndexOutOfRange,
    /// An output name has no producer in the contract's producer_map.
    MissingProducerEntry,
    /// An op input value is declared with a different SSA name than expected.
    InputValueMismatch,
}

impl std::fmt::Display for VerificationErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingOutput => write!(f, "missing_output"),
            Self::WrongOutputShape => write!(f, "wrong_output_shape"),
            Self::UndefinedOpInput => write!(f, "undefined_op_input"),
            Self::WrongOutputProducer => write!(f, "wrong_output_producer"),
            Self::MissingValueType => write!(f, "missing_value_type"),
            Self::ConstLengthMismatch => write!(f, "const_length_mismatch"),
            Self::OutputNameNotFoundInOps => write!(f, "output_name_not_found_in_ops"),
            Self::UnmappedBlockOutput => write!(f, "unmapped_block_output"),
            Self::OpIndexOutOfRange => write!(f, "op_index_out_of_range"),
            Self::MissingProducerEntry => write!(f, "missing_producer_entry"),
            Self::InputValueMismatch => write!(f, "input_value_mismatch"),
        }
    }
}

/// A single structural verification error with machine-readable code.
#[derive(Debug, Clone)]
pub struct VerificationError {
    pub code: VerificationErrorCode,
    pub message: String,
}

impl std::fmt::Display for VerificationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

// ── Contract types ────────────────────────────────────────────────────────

/// Contract describing the expected structure of a diagnostic MIL graph.
///
/// Every field is known before the MIL program is built. The verifier checks
/// the built program against this contract, catching local builder bugs before
/// `coremlcompiler` is invoked.
pub struct DiagnosticGraphContract {
    /// Unique graph name (e.g., "sigmoid_only", "matmul_n2").
    pub name: &'static str,
    /// Human-readable description.
    pub description: &'static str,
    /// Track classification: "elementwise", "output_width", or "auxiliary".
    pub track: &'static str,
    /// Shape parameter k (input/weight channels).
    pub shape_k: u32,
    /// Shape parameter n (output width).
    pub shape_n: u32,
    /// Declared input names for the MIL function.
    pub input_names: &'static [&'static str],
    /// Block output SSA names (the names that appear in program function outputs).
    pub output_names: &'static [&'static str],
    /// Expected output shapes — exact rank and dimension sequence per output.
    /// `[1, 4]` is not equivalent to `[4, 1]` or `[4]`.
    pub output_shapes: &'static [&'static [u64]],
    /// Expected data type for all tensors.
    pub dtype: mil_spec::DataType,
    /// Ordered list of operation type names (e.g., `["add"]`, `["const", "add"]`).
    pub op_list: &'static [&'static str],
    /// Producer map: for each output_name → (op_index, expected_op_type, produced_ssa_value).
    /// The verifier checks that the operation at op_index produces the named SSA
    /// value and that this value is exported as output_name.
    pub producer_map: &'static [(&'static str, usize, &'static str, &'static str)],
    /// Expected op input bindings: (op_index, input_arg_name, expected_consumed_value).
    /// The verifier checks that operation at op_index has input `input_arg_name`
    /// bound to the SSA value `expected_consumed_value`.
    pub op_inputs: &'static [(usize, &'static str, &'static str)],
    /// Expected fate annotation: "unknown", "expected_harness_passthrough",
    /// "expected_pass", "expected_compile_fail".
    pub expected_fate: &'static str,
    /// Graph builder function — takes a fresh MilBuilder and returns a complete one.
    pub build: fn(MilBuilder) -> Result<MilBuilder, MilBuildError>,
}

// ── Structural verifier ───────────────────────────────────────────────────

/// Collect all SSA values defined by MIL program inputs and operations.
fn collect_defined_values(
    program: &mil_spec::Program,
) -> Vec<String> {
    let mut values = Vec::new();
    // Collect input names.
    for func in program.functions.values() {
        for inp in &func.inputs {
            values.push(inp.name.clone());
        }
        for block in func.block_specializations.values() {
            for op in &block.operations {
                for out in &op.outputs {
                    values.push(out.name.clone());
                }
            }
        }
    }
    values
}

/// Resolve the shape of a value from the program's operation outputs.
fn resolve_value_shape(
    op_list: &[mil_spec::Operation],
    value_name: &str,
) -> Option<Vec<u64>> {
    for op in op_list {
        for out in &op.outputs {
            if out.name == value_name {
                if let Some(ref vt) = out.r#type {
                    if let Some(ref tt) = vt.r#type {
                        if let mil_spec::value_type::Type::TensorType(ref tensor) = tt {
                            let dims: Vec<u64> = tensor.dimensions.iter()
                                .filter_map(|d| match d.dimension {
                                    Some(dimension::Dimension::Constant(ref cd)) => Some(cd.size),
                                    _ => None,
                                })
                                .collect();
                            // Only return if all dimensions resolved.
                            if dims.len() == tensor.dimensions.len() {
                                return Some(dims);
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Verify a built MIL program against its diagnostic contract.
///
/// Returns `Ok(())` if the program matches the contract exactly.
/// Returns `Err` with a list of `VerificationError` items detailing every
/// structural violation. The verifier runs the full suite and collects all
/// errors rather than short-circuiting, so a single call reveals all
/// structural issues at once.
pub fn verify_graph_contract(
    program: &mil_spec::Program,
    contract: &DiagnosticGraphContract,
) -> Result<(), Vec<VerificationError>> {
    let mut errors: Vec<VerificationError> = Vec::new();

    // Locate the main function and its block.
    let (func, block) = match program.functions.get("main") {
        Some(f) => {
            match f.block_specializations.get("CoreML9") {
                Some(b) => (f, b),
                None => {
                    errors.push(VerificationError {
                        code: VerificationErrorCode::MissingOutput,
                        message: "no block specialization 'CoreML9' found in function 'main'".into(),
                    });
                    return Err(errors);
                }
            }
        }
        None => {
            errors.push(VerificationError {
                code: VerificationErrorCode::MissingOutput,
                message: "no function 'main' found in program".into(),
            });
            return Err(errors);
        }
    };

    // 1. Check block outputs match contract.
    for out_name in contract.output_names {
        if !block.outputs.iter().any(|o| o == out_name) {
            errors.push(VerificationError {
                code: VerificationErrorCode::MissingOutput,
                message: format!("output '{}' is not in block outputs", out_name),
            });
        }
    }

    // 2. Check op count matches contract.
    if block.operations.len() != contract.op_list.len() {
        errors.push(VerificationError {
            code: VerificationErrorCode::OpIndexOutOfRange,
            message: format!(
                "expected {} operations, got {}",
                contract.op_list.len(),
                block.operations.len()
            ),
        });
    }

    // 3. Check op types and producer map.
    let defined_values = collect_defined_values(program);

    // Build a lookup: output_name → (produced_ssa_value, op_index, op_type)
    let contract_producer: HashMap<&str, (&str, usize, &str)> = contract
        .producer_map
        .iter()
        .map(|(out_name, idx, op_type, ssa_val)| (*out_name, (*ssa_val, *idx, *op_type)))
        .collect();

    // Check each output in the contract has a producer entry.
    for out_name in contract.output_names {
        if !contract_producer.contains_key(out_name) {
            errors.push(VerificationError {
                code: VerificationErrorCode::MissingProducerEntry,
                message: format!(
                    "output '{}' has no producer entry in contract's producer_map",
                    out_name
                ),
            });
        }
    }

    // Verify each operation.
    let min_ops = block.operations.len().min(contract.op_list.len());
    for (i, op) in block.operations.iter().enumerate() {
        if i >= contract.op_list.len() {
            break;
        }
        let expected_type = contract.op_list[i];

        // Check op type.
        if op.r#type != expected_type {
            errors.push(VerificationError {
                code: VerificationErrorCode::WrongOutputProducer,
                message: format!(
                    "operation at index {} expected type '{}', got '{}'",
                    i, expected_type, op.r#type
                ),
            });
        }

        // Check that every op output name appears in contract outputs (if listed as producer).
        for out in &op.outputs {
            // Check if this op output is an output in the contract.
            let is_contract_output = contract.output_names.iter().any(|n| n == &out.name);
            if is_contract_output {
                // Verify producer map says this op produces this output.
                if let Some(&(expected_ssa, expected_idx, expected_type)) =
                    contract_producer.get(out.name.as_str())
                {
                    if i != expected_idx {
                        errors.push(VerificationError {
                            code: VerificationErrorCode::WrongOutputProducer,
                            message: format!(
                                "output '{}' expected at op index {}, but found at op index {}",
                                out.name, expected_idx, i
                            ),
                        });
                    }
                    if out.name != expected_ssa {
                        errors.push(VerificationError {
                            code: VerificationErrorCode::WrongOutputProducer,
                            message: format!(
                                "output '{}' expected produced SSA value '{}', but value is '{}'",
                                out.name, expected_ssa, out.name
                            ),
                        });
                    }
                }
            }
        }

        // Check operation input bindings.
        let contract_inputs_for_op: Vec<&(usize, &str, &str)> = contract
            .op_inputs
            .iter()
            .filter(|(idx, _, _)| *idx == i)
            .collect();
        for (_, input_arg, expected_value) in &contract_inputs_for_op {
            let actual = op.inputs.get(*input_arg);
            match actual {
                Some(arg) => {
                    let found = arg.arguments.iter().any(|b| match b.binding {
                        Some(argument::binding::Binding::Name(ref n)) => n == expected_value,
                        _ => false,
                    });
                    if !found {
                        errors.push(VerificationError {
                            code: VerificationErrorCode::InputValueMismatch,
                            message: format!(
                                "op '{}' input '{}' expected value '{}', but actual value differs",
                                op.r#type, input_arg, expected_value
                            ),
                        });
                    }
                }
                None => {
                    errors.push(VerificationError {
                        code: VerificationErrorCode::UndefinedOpInput,
                        message: format!(
                            "op '{}' missing input '{}' (expected '{}')",
                            op.r#type, input_arg, expected_value
                        ),
                    });
                }
            }
        }
    }

    // 4. Check output shapes match contract exactly (rank + dimensions).
    let all_ops: Vec<mil_spec::Operation> = block.operations.clone();
    for (i, out_name) in contract.output_names.iter().enumerate() {
        let expected_shape = contract.output_shapes[i];
        // Try to resolve from op outputs.
        if let Some(actual_shape) = resolve_value_shape(&all_ops, out_name) {
            if actual_shape.len() != expected_shape.len() {
                errors.push(VerificationError {
                    code: VerificationErrorCode::WrongOutputShape,
                    message: format!(
                        "output '{}' expected rank {}, got rank {} (shape {:?} vs {:?})",
                        out_name, expected_shape.len(), actual_shape.len(),
                        expected_shape, actual_shape
                    ),
                });
            } else {
                for (dim_idx, (&expected_dim, &actual_dim)) in
                    expected_shape.iter().zip(actual_shape.iter()).enumerate()
                {
                    if expected_dim != actual_dim {
                        errors.push(VerificationError {
                            code: VerificationErrorCode::WrongOutputShape,
                            message: format!(
                                "output '{}' dimension {} expected {}, got {}",
                                out_name, dim_idx, expected_dim, actual_dim
                            ),
                        });
                    }
                }
            }
        } else if expected_shape.is_empty() {
            // Scalar output with no shape info is acceptable fallback.
        }
    }

    // 5. Check all op inputs reference defined values.
    for (i, op) in block.operations.iter().enumerate() {
        for input_list in op.inputs.values() {
            for b in &input_list.arguments {
                if let Some(argument::binding::Binding::Name(ref n)) = b.binding {
                    if !defined_values.iter().any(|v| v == n) {
                        // Also check function inputs.
                        let is_function_input = func.inputs.iter().any(|fi| &fi.name == n);
                        if !is_function_input {
                            errors.push(VerificationError {
                                code: VerificationErrorCode::UndefinedOpInput,
                                message: format!(
                                    "op '{}' at index {} references undefined SSA value '{}'",
                                    op.r#type, i, n
                                ),
                            });
                        }
                    }
                }
            }
        }
    }

    // 6. Check value types exist for all defined values.
    for op in &block.operations {
        for out in &op.outputs {
            if out.r#type.is_none() {
                errors.push(VerificationError {
                    code: VerificationErrorCode::MissingValueType,
                    message: format!(
                        "op output '{}' (type {}) has no type annotation",
                        out.name, op.r#type
                    ),
                });
            }
        }
    }

    // 7. Check const tensor lengths match declared shapes.
    for op in &block.operations {
        if op.r#type == "const" {
            if let Some(val) = op.attributes.get("val") {
                if let Some(val_value) = &val.value {
                    if let value::Value::ImmediateValue(imm) = val_value {
                        if let Some(value::immediate_value::Value::Tensor(tv)) = &imm.value {
                            if let Some(tensor_val) = &tv.value {
                                match tensor_val {
                                    tensor_value::Value::Floats(floats) => {
                                        for out in &op.outputs {
                                            if let Some(vt) = &out.r#type {
                                                if let Some(tt) = &vt.r#type {
                                                    if let mil_spec::value_type::Type::TensorType(tensor_type) = tt {
                                                        let product: u64 = tensor_type.dimensions.iter()
                                                            .filter_map(|d| {
                                                                if let Some(dimension::Dimension::Constant(cd)) = &d.dimension {
                                                                    Some(cd.size)
                                                                } else {
                                                                    None
                                                                }
                                                            })
                                                            .product();
                                                        if product > 0 && product != floats.values.len() as u64 {
                                                            errors.push(VerificationError {
                                                                code: VerificationErrorCode::ConstLengthMismatch,
                                                                message: format!(
                                                                    "const output '{}' shape {:?} implies {} elements, but has {} float values",
                                                                    out.name, tensor_type.dimensions, product,
                                                                    floats.values.len()
                                                                ),
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

// ── MIL op helpers (local copies, mirroring graph_catalog.rs helpers) ─────

fn manual_tensor_type(dtype: mil_spec::DataType, shape: &[u64]) -> mil_spec::TensorType {
    let dims: Vec<mil_spec::Dimension> = shape
        .iter()
        .map(|&s| mil_spec::Dimension {
            dimension: Some(dimension::Dimension::Constant(
                dimension::ConstantDimension { size: s },
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

fn manual_value_type_tensor(tt: mil_spec::TensorType) -> mil_spec::ValueType {
    mil_spec::ValueType {
        r#type: Some(mil_spec::value_type::Type::TensorType(tt)),
    }
}

fn manual_named_arg(name: &str) -> mil_spec::Argument {
    mil_spec::Argument {
        arguments: vec![argument::Binding {
            binding: Some(argument::binding::Binding::Name(name.to_string())),
        }],
    }
}

fn manual_string_attr(val: &str) -> mil_spec::Value {
    let string_tensor = mil_spec::TensorValue {
        value: Some(tensor_value::Value::Strings(
            tensor_value::RepeatedStrings {
                values: vec![val.to_string()],
            },
        )),
    };
    mil_spec::Value {
        doc_string: String::new(),
        r#type: Some(manual_value_type_tensor(mil_spec::TensorType {
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

fn manual_int32s_attr(vals: &[i32]) -> mil_spec::Value {
    let int_tensor = mil_spec::TensorValue {
        value: Some(tensor_value::Value::Ints(tensor_value::RepeatedInts {
            values: vals.to_vec(),
        })),
    };
    mil_spec::Value {
        doc_string: String::new(),
        r#type: Some(manual_value_type_tensor(mil_spec::TensorType {
            data_type: mil_spec::DataType::Int64 as i32,
            rank: 1,
            dimensions: vec![mil_spec::Dimension {
                dimension: Some(dimension::Dimension::Constant(
                    dimension::ConstantDimension {
                        size: vals.len() as u64,
                    },
                )),
            }],
            attributes: HashMap::new(),
        })),
        value: Some(value::Value::ImmediateValue(value::ImmediateValue {
            value: Some(value::immediate_value::Value::Tensor(int_tensor)),
        })),
    }
}

fn make_elementwise_op(
    builder: MilBuilder,
    mode: &str,
    inputs: Vec<(&str, &str)>,
    shape: &[u64],
    out_name: &str,
) -> Result<MilBuilder, MilBuildError> {
    let entry = resolve_unary_op_type(mode)
        .ok_or_else(|| MilBuildError::UnsupportedUnaryOpMode { mode: mode.to_string() })?;

    let vt = manual_value_type_tensor(manual_tensor_type(
        mil_spec::DataType::Float32,
        shape,
    ));
    let mut attrs = HashMap::new();
    attrs.insert("name".to_string(), manual_string_attr(out_name));
    // Only emit mode attribute if the dedicated op type requires attributes.
    if entry.requires_attrs {
        attrs.insert("mode".to_string(), manual_string_attr(mode));
    }
    let mut inputs_map = HashMap::new();
    for (arg_key, value_name) in inputs {
        inputs_map.insert(arg_key.to_string(), manual_named_arg(value_name));
    }
    let op = mil_spec::Operation {
        r#type: entry.mil_op_type.to_string(),
        inputs: inputs_map,
        outputs: vec![mil_spec::NamedValueType {
            name: out_name.to_string(),
            r#type: Some(vt.clone()),
        }],
        blocks: vec![],
        attributes: attrs,
    };
    Ok(builder.operation(op, Some((out_name, vt))))
}

fn make_add_op(builder: MilBuilder, a: &str, b: &str, out_name: &str) -> MilBuilder {
    let mut inputs_map = HashMap::new();
    inputs_map.insert("x".to_string(), manual_named_arg(a));
    inputs_map.insert("y".to_string(), manual_named_arg(b));
    let vt = manual_value_type_tensor(manual_tensor_type(
        mil_spec::DataType::Float32,
        &[1, 1],
    ));
    let mut attrs = HashMap::new();
    attrs.insert("name".to_string(), manual_string_attr(out_name));
    let op = mil_spec::Operation {
        r#type: "add".to_string(),
        inputs: inputs_map,
        outputs: vec![mil_spec::NamedValueType {
            name: out_name.to_string(),
            r#type: Some(vt.clone()),
        }],
        blocks: vec![],
        attributes: attrs,
    };
    builder.operation(op, Some((out_name, vt)))
}

fn make_mul_op(builder: MilBuilder, a: &str, b: &str, out_name: &str) -> MilBuilder {
    let mut inputs_map = HashMap::new();
    inputs_map.insert("x".to_string(), manual_named_arg(a));
    inputs_map.insert("y".to_string(), manual_named_arg(b));
    let vt = manual_value_type_tensor(manual_tensor_type(
        mil_spec::DataType::Float32,
        &[1, 1],
    ));
    let mut attrs = HashMap::new();
    attrs.insert("name".to_string(), manual_string_attr(out_name));
    let op = mil_spec::Operation {
        r#type: "mul".to_string(),
        inputs: inputs_map,
        outputs: vec![mil_spec::NamedValueType {
            name: out_name.to_string(),
            r#type: Some(vt.clone()),
        }],
        blocks: vec![],
        attributes: attrs,
    };
    builder.operation(op, Some((out_name, vt)))
}

// ── Diagnostic graph builders ────────────────────────────────────────────

/// sigmoid_only: input x, element_wise(mode=logistic), output sig_0
/// k=4, n=1
fn build_sigmoid_only(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    builder = make_elementwise_op(builder, "logistic", vec![("x", "x")], &[1, 4], "sig_0")?;
    Ok(builder.output("sig_0"))
}

/// add_input_input: input x, input y, add(x, y), output add_0
/// k=4, n=1
fn build_add_input_input(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    builder = builder.input("y", mil_spec::DataType::Float32, &[1, 4]);
    builder = make_add_op(builder, "x", "y", "add_0");
    Ok(builder.output("add_0"))
}

/// add_input_const: input x, const c, add(x, c_0), output add_1
/// k=4, n=1
fn build_add_input_const(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let vals: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
    builder = builder.const_f32("c", &vals, &[1, 4]);
    builder = make_add_op(builder, "x", "c_0", "add_1");
    Ok(builder.output("add_1"))
}

/// mul_input_input: input x, input y, mul(x, y), output mul_0
/// k=4, n=1
fn build_mul_input_input(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    builder = builder.input("y", mil_spec::DataType::Float32, &[1, 4]);
    builder = make_mul_op(builder, "x", "y", "mul_0");
    Ok(builder.output("mul_0"))
}

/// mul_input_const: input x, const c, mul(x, c_0), output mul_1
/// k=4, n=1
fn build_mul_input_const(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let vals: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
    builder = builder.const_f32("c", &vals, &[1, 4]);
    builder = make_mul_op(builder, "x", "c_0", "mul_1");
    Ok(builder.output("mul_1"))
}

/// sigmoid_mul: input x, element_wise(logistic) → sig_0, mul(x, sig_0) → mul_1
/// k=4, n=1
fn build_sigmoid_mul(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    builder = make_elementwise_op(builder, "logistic", vec![("x", "x")], &[1, 4], "sig_0")?;
    builder = make_mul_op(builder, "x", "sig_0", "mul_1");
    Ok(builder.output("mul_1"))
}

/// add_n2: input x, input y, add(x, y), output add_0 (k=4, n=2)
fn build_add_n2(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    builder = builder.input("y", mil_spec::DataType::Float32, &[1, 4]);
    builder = make_add_op(builder, "x", "y", "add_0");
    Ok(builder.output("add_0"))
}

/// matmul_n1: input x, const w, matmul(x, w_0), output matmul_1 (k=4, n=1)
fn build_matmul_n1(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let w: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
    builder = builder.const_f32("w", &w, &[4, 1]);
    builder = builder.matmul("x", "w_0");
    Ok(builder.output("matmul_1"))
}

/// matmul_n2: input x, const w, matmul(x, w_0), output matmul_1 (k=4, n=2)
fn build_matmul_n2(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let w: Vec<f32> = (0..8).map(|i| (i + 1) as f32).collect();
    builder = builder.const_f32("w", &w, &[4, 2]);
    builder = builder.matmul("x", "w_0");
    Ok(builder.output("matmul_1"))
}

/// branch_n1: input x, const wa, const wb, matmul(x,wa_0), matmul(x,wb_1),
///            add(matmul_2, matmul_3), output add_4 (k=4, n=1)
fn build_branch_n1(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let wa: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
    let wb: Vec<f32> = (0..4).map(|i| (i + 5) as f32).collect();
    builder = builder.const_f32("wa", &wa, &[4, 1]);
    builder = builder.const_f32("wb", &wb, &[4, 1]);
    builder = builder.matmul("x", "wa_0");
    builder = builder.matmul("x", "wb_1");
    builder = make_add_op(builder, "matmul_2", "matmul_3", "add_4");
    Ok(builder.output("add_4"))
}

/// branch_n2: same as branch_n1 but with n=2 weights
/// k=4, n=2
fn build_branch_n2(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let wa: Vec<f32> = (0..8).map(|i| (i + 1) as f32).collect();
    let wb: Vec<f32> = (0..8).map(|i| (i + 5) as f32).collect();
    builder = builder.const_f32("wa", &wa, &[4, 2]);
    builder = builder.const_f32("wb", &wb, &[4, 2]);
    builder = builder.matmul("x", "wa_0");
    builder = builder.matmul("x", "wb_1");
    builder = make_add_op(builder, "matmul_2", "matmul_3", "add_4");
    Ok(builder.output("add_4"))
}

/// multi_n1: input x, const w, const bias, matmul(x, w_0), add(x, bias_1),
///           outputs matmul_2, add_3 (k=4, n=1)
fn build_multi_n1(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let w: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
    let bias: Vec<f32> = (0..4).map(|i| (i + 10) as f32).collect();
    builder = builder.const_f32("w", &w, &[4, 1]);
    builder = builder.const_f32("bias", &bias, &[1, 4]);
    builder = builder.matmul("x", "w_0");
    builder = make_add_op(builder, "x", "bias_1", "add_3");
    builder = builder.output("matmul_2");
    Ok(builder.output("add_3"))
}

/// multi_n2: same as multi_n1 but with n=2 weights
/// k=4, n=2
fn build_multi_n2(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let w: Vec<f32> = (0..8).map(|i| (i + 1) as f32).collect();
    let bias: Vec<f32> = (0..4).map(|i| (i + 10) as f32).collect();
    builder = builder.const_f32("w", &w, &[4, 2]);
    builder = builder.const_f32("bias", &bias, &[1, 4]);
    builder = builder.matmul("x", "w_0");
    builder = make_add_op(builder, "x", "bias_1", "add_3");
    builder = builder.output("matmul_2");
    Ok(builder.output("add_3"))
}

/// identity: input x, output x directly (no MIL ops — bare output declaration)
fn build_identity(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    Ok(builder.output("x"))
}

/// chain_matmul_add_silu_small: matmul→add→sigmoid→mul chain at k=4, n=1
/// Replicates graph_catalog::build_chain_matmul_add_silu at small shape
/// using fixed op type resolution.
fn build_chain_matmul_add_silu_small(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
    let w: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
    let bias: Vec<f32> = (0..4).map(|i| (i + 10) as f32).collect();
    builder = builder.const_f32("w", &w, &[4, 1]);
    builder = builder.matmul("x", "w_0");
    builder = builder.const_f32("bias", &bias, &[1, 4]);
    builder = builder.add("matmul_1", "bias_2");
    builder = make_elementwise_op(builder, "logistic", vec![("x", "add_3")], &[1, 1], "sig_0")?;
    builder = make_mul_op(builder, "add_3", "sig_0", "mul_1");
    Ok(builder.output("mul_1"))
}

// ── Diagnostic Graph Catalog ─────────────────────────────────────────────

/// Elementwise track graphs.
pub const ELEMENTWISE_GRAPHS: &[DiagnosticGraphContract] = &[
    DiagnosticGraphContract {
        name: "sigmoid_only",
        description: "unary elementwise sigmoid (logistic mode), single input",
        track: "elementwise",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["sig_0"],
        output_shapes: &[&[1, 4]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["sigmoid"],
        producer_map: &[("sig_0", 0, "sigmoid", "sig_0")],
        op_inputs: &[(0, "x", "x")],
        expected_fate: "expected_compile_fail",
        build: build_sigmoid_only,
    },
    DiagnosticGraphContract {
        name: "add_input_input",
        description: "binary add with two inputs",
        track: "elementwise",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x", "y"],
        output_names: &["add_0"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["add"],
        producer_map: &[("add_0", 0, "add", "add_0")],
        op_inputs: &[(0, "x", "x"), (0, "y", "y")],
        expected_fate: "unknown",
        build: build_add_input_input,
    },
    DiagnosticGraphContract {
        name: "add_input_const",
        description: "binary add with one const input",
        track: "elementwise",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["add_1"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "add"],
        producer_map: &[("add_1", 1, "add", "add_1")],
        op_inputs: &[(1, "x", "x"), (1, "y", "c_0")],
        expected_fate: "unknown",
        build: build_add_input_const,
    },
    DiagnosticGraphContract {
        name: "mul_input_input",
        description: "binary mul with two inputs",
        track: "elementwise",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x", "y"],
        output_names: &["mul_0"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["mul"],
        producer_map: &[("mul_0", 0, "mul", "mul_0")],
        op_inputs: &[(0, "x", "x"), (0, "y", "y")],
        expected_fate: "unknown",
        build: build_mul_input_input,
    },
    DiagnosticGraphContract {
        name: "mul_input_const",
        description: "binary mul with one const input",
        track: "elementwise",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["mul_1"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "mul"],
        producer_map: &[("mul_1", 1, "mul", "mul_1")],
        op_inputs: &[(1, "x", "x"), (1, "y", "c_0")],
        expected_fate: "unknown",
        build: build_mul_input_const,
    },
    DiagnosticGraphContract {
        name: "sigmoid_mul",
        description: "sigmoid → mul (chained elementwise ops)",
        track: "elementwise",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["mul_1"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["sigmoid", "mul"],
        producer_map: &[("mul_1", 1, "mul", "mul_1")],
        op_inputs: &[(0, "x", "x"), (1, "x", "x"), (1, "y", "sig_0")],
        expected_fate: "unknown",
        build: build_sigmoid_mul,
    },
    DiagnosticGraphContract {
        name: "chain_matmul_add_silu_small",
        description: "matmul→add→sigmoid→mul chain at small shape (k=4,n=1)",
        track: "elementwise",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["mul_1"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "matmul", "const", "add", "sigmoid", "mul"],
        producer_map: &[("mul_1", 5, "mul", "mul_1")],
        op_inputs: &[(5, "x", "add_3"), (5, "y", "sig_0")],
        expected_fate: "unknown",
        build: build_chain_matmul_add_silu_small,
    },
];

/// Output-width track graphs.
pub const OUTPUT_WIDTH_GRAPHS: &[DiagnosticGraphContract] = &[
    DiagnosticGraphContract {
        name: "add_n2",
        description: "binary add with two inputs at n=2",
        track: "output_width",
        shape_k: 4,
        shape_n: 2,
        input_names: &["x", "y"],
        output_names: &["add_0"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["add"],
        producer_map: &[("add_0", 0, "add", "add_0")],
        op_inputs: &[(0, "x", "x"), (0, "y", "y")],
        expected_fate: "unknown",
        build: build_add_n2,
    },
    DiagnosticGraphContract {
        name: "matmul_n1",
        description: "basic matmul with n=1 (known pass from 8-family catalog)",
        track: "output_width",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["matmul_1"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "matmul"],
        producer_map: &[("matmul_1", 1, "matmul", "matmul_1")],
        op_inputs: &[(1, "x", "x"), (1, "y", "w_0")],
        expected_fate: "expected_pass",
        build: build_matmul_n1,
    },
    DiagnosticGraphContract {
        name: "matmul_n2",
        description: "basic matmul with n=2",
        track: "output_width",
        shape_k: 4,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["matmul_1"],
        output_shapes: &[&[1, 2]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "matmul"],
        producer_map: &[("matmul_1", 1, "matmul", "matmul_1")],
        op_inputs: &[(1, "x", "x"), (1, "y", "w_0")],
        expected_fate: "expected_pass",
        build: build_matmul_n2,
    },
    DiagnosticGraphContract {
        name: "branch_n1",
        description: "branch-rejoin with n=1 (known pass from 8-family catalog)",
        track: "output_width",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"),
            (2, "y", "wa_0"),
            (3, "x", "x"),
            (3, "y", "wb_1"),
            (4, "x", "matmul_2"),
            (4, "y", "matmul_3"),
        ],
        expected_fate: "expected_pass",
        build: build_branch_n1,
    },
    DiagnosticGraphContract {
        name: "branch_n2",
        description: "branch-rejoin with n=2 (golden reproducer)",
        track: "output_width",
        shape_k: 4,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"),
            (2, "y", "wa_0"),
            (3, "x", "x"),
            (3, "y", "wb_1"),
            (4, "x", "matmul_2"),
            (4, "y", "matmul_3"),
        ],
        expected_fate: "expected_compile_fail",
        build: build_branch_n2,
    },
    DiagnosticGraphContract {
        name: "multi_n1",
        description: "two-output graph with n=1 (known pass from 8-family catalog)",
        track: "output_width",
        shape_k: 4,
        shape_n: 1,
        input_names: &["x"],
        output_names: &["matmul_2", "add_3"],
        output_shapes: &[&[1, 1], &[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "add"],
        producer_map: &[
            ("matmul_2", 2, "matmul", "matmul_2"),
            ("add_3", 3, "add", "add_3"),
        ],
        op_inputs: &[
            (2, "x", "x"),
            (2, "y", "w_0"),
            (3, "x", "x"),
            (3, "y", "bias_1"),
        ],
        expected_fate: "expected_pass",
        build: build_multi_n1,
    },
    DiagnosticGraphContract {
        name: "multi_n2",
        description: "two-output graph with n=2",
        track: "output_width",
        shape_k: 4,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["matmul_2", "add_3"],
        output_shapes: &[&[1, 2], &[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "add"],
        producer_map: &[
            ("matmul_2", 2, "matmul", "matmul_2"),
            ("add_3", 3, "add", "add_3"),
        ],
        op_inputs: &[
            (2, "x", "x"),
            (2, "y", "w_0"),
            (3, "x", "x"),
            (3, "y", "bias_1"),
        ],
        expected_fate: "expected_pass",
        build: build_multi_n2,
    },
];

/// Auxiliary diagnostic graphs.
pub const AUXILIARY_GRAPHS: &[DiagnosticGraphContract] = &[DiagnosticGraphContract {
    name: "identity",
    description: "input passthrough with no MIL ops (bare output declaration)",
    track: "auxiliary",
    shape_k: 4,
    shape_n: 1,
    input_names: &["x"],
    output_names: &["x"],
    output_shapes: &[&[1, 4]],
    dtype: mil_spec::DataType::Float32,
    op_list: &[],
    producer_map: &[("x", 0, "", "x")],
    op_inputs: &[],
    expected_fate: "expected_harness_passthrough",
    build: build_identity,
}];

/// All diagnostic graphs across all tracks.
pub fn all_diagnostic_graphs() -> Vec<&'static DiagnosticGraphContract> {
    let mut v: Vec<&'static DiagnosticGraphContract> = Vec::with_capacity(
        ELEMENTWISE_GRAPHS.len() + OUTPUT_WIDTH_GRAPHS.len() + AUXILIARY_GRAPHS.len() + BRANCH_SCALE_GRAPHS.len(),
    );
    for g in ELEMENTWISE_GRAPHS {
        v.push(g);
    }
    for g in OUTPUT_WIDTH_GRAPHS {
        v.push(g);
    }
    for g in AUXILIARY_GRAPHS {
        v.push(g);
    }
    for g in BRANCH_SCALE_GRAPHS {
        v.push(g);
    }
    v
}

/// Graphs for a specific track.
pub fn graphs_for_track(track: &str) -> Vec<&'static DiagnosticGraphContract> {
    match track {
        "elementwise" => ELEMENTWISE_GRAPHS.iter().collect(),
        "output_width" => OUTPUT_WIDTH_GRAPHS.iter().collect(),
        "auxiliary" => AUXILIARY_GRAPHS.iter().collect(),
        "branch_scale" => BRANCH_SCALE_GRAPHS.iter().collect(),
        "all" => all_diagnostic_graphs(),
        _ => panic!("unknown track '{track}', use elementwise|output_width|auxiliary|branch_scale|all"),
    }
}

/// Branch-scale diagnostic graphs — varying (k,n) pairs to identify the
/// smallest failing branch_rejoin shape.
///
/// Each graph: input x, const wa, const wb, matmul(x,wa), matmul(x,wb),
/// add(matmul_a, matmul_b), output add_4.
/// Output shape is [1,1] matching make_add_op's invariants.
macro_rules! branch_scale_builder {
    ($name:ident, $k:expr, $n:expr) => {
        fn $name(mut builder: MilBuilder) -> Result<MilBuilder, MilBuildError> {
            let count = ($k * $n) as usize;
            let wa: Vec<f32> = (0..count).map(|i| (i + 1) as f32).collect();
            let wb: Vec<f32> = (0..count).map(|i| (i + 5) as f32).collect();
            builder = builder.const_f32("wa", &wa, &[$k as i64, $n as i64]);
            builder = builder.const_f32("wb", &wb, &[$k as i64, $n as i64]);
            builder = builder.matmul("x", "wa_0");
            builder = builder.matmul("x", "wb_1");
            builder = make_add_op(builder, "matmul_2", "matmul_3", "add_4");
            Ok(builder.output("add_4"))
        }
    };
}

branch_scale_builder!(build_branch_k4_n2, 4, 2);
branch_scale_builder!(build_branch_k8_n2, 8, 2);
branch_scale_builder!(build_branch_k16_n2, 16, 2);
branch_scale_builder!(build_branch_k32_n2, 32, 2);
branch_scale_builder!(build_branch_k64_n2, 64, 2);
branch_scale_builder!(build_branch_k128_n2, 128, 2);
branch_scale_builder!(build_branch_k4_n8, 4, 8);
branch_scale_builder!(build_branch_k8_n8, 8, 8);
branch_scale_builder!(build_branch_k16_n16, 16, 16);
branch_scale_builder!(build_branch_k32_n32, 32, 32);
branch_scale_builder!(build_branch_k64_n64, 64, 64);
branch_scale_builder!(build_branch_k128_n128, 128, 128);

/// Branch-scale track graphs (k-sweep at fixed n, then both scaled together).
pub const BRANCH_SCALE_GRAPHS: &[DiagnosticGraphContract] = &[
    DiagnosticGraphContract {
        name: "branch_k4_n2",
        description: "branch-rejoin at k=4, n=2 (baseline from output_width track)",
        track: "branch_scale",
        shape_k: 4,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k4_n2,
    },
    DiagnosticGraphContract {
        name: "branch_k8_n2",
        description: "branch-rejoin at k=8, n=2",
        track: "branch_scale",
        shape_k: 8,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k8_n2,
    },
    DiagnosticGraphContract {
        name: "branch_k16_n2",
        description: "branch-rejoin at k=16, n=2",
        track: "branch_scale",
        shape_k: 16,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k16_n2,
    },
    DiagnosticGraphContract {
        name: "branch_k32_n2",
        description: "branch-rejoin at k=32, n=2",
        track: "branch_scale",
        shape_k: 32,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k32_n2,
    },
    DiagnosticGraphContract {
        name: "branch_k64_n2",
        description: "branch-rejoin at k=64, n=2",
        track: "branch_scale",
        shape_k: 64,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k64_n2,
    },
    DiagnosticGraphContract {
        name: "branch_k128_n2",
        description: "branch-rejoin at k=128, n=2",
        track: "branch_scale",
        shape_k: 128,
        shape_n: 2,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k128_n2,
    },
    DiagnosticGraphContract {
        name: "branch_k4_n8",
        description: "branch-rejoin at k=4, n=8",
        track: "branch_scale",
        shape_k: 4,
        shape_n: 8,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k4_n8,
    },
    DiagnosticGraphContract {
        name: "branch_k8_n8",
        description: "branch-rejoin at k=8, n=8",
        track: "branch_scale",
        shape_k: 8,
        shape_n: 8,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k8_n8,
    },
    DiagnosticGraphContract {
        name: "branch_k16_n16",
        description: "branch-rejoin at k=16, n=16",
        track: "branch_scale",
        shape_k: 16,
        shape_n: 16,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k16_n16,
    },
    DiagnosticGraphContract {
        name: "branch_k32_n32",
        description: "branch-rejoin at k=32, n=32",
        track: "branch_scale",
        shape_k: 32,
        shape_n: 32,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k32_n32,
    },
    DiagnosticGraphContract {
        name: "branch_k64_n64",
        description: "branch-rejoin at k=64, n=64",
        track: "branch_scale",
        shape_k: 64,
        shape_n: 64,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k64_n64,
    },
    DiagnosticGraphContract {
        name: "branch_k128_n128",
        description: "branch-rejoin at k=128, n=128",
        track: "branch_scale",
        shape_k: 128,
        shape_n: 128,
        input_names: &["x"],
        output_names: &["add_4"],
        output_shapes: &[&[1, 1]],
        dtype: mil_spec::DataType::Float32,
        op_list: &["const", "const", "matmul", "matmul", "add"],
        producer_map: &[("add_4", 4, "add", "add_4")],
        op_inputs: &[
            (2, "x", "x"), (2, "y", "wa_0"),
            (3, "x", "x"), (3, "y", "wb_1"),
            (4, "x", "matmul_2"), (4, "y", "matmul_3"),
        ],
        expected_fate: "unknown",
        build: build_branch_k128_n128,
    },
];

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mil_builder::MilBuilder;

    /// Helper: build a graph from its contract, then verify it.
    fn build_and_verify(contract: &DiagnosticGraphContract) -> Result<(), Vec<VerificationError>> {
        let program = build_diagnostic_graph(contract);
        verify_graph_contract(&program, contract)
    }

    fn build_diagnostic_graph(contract: &DiagnosticGraphContract) -> mil_spec::Program {
        let input_shape: &[i64] = &[1, contract.shape_k as i64];
        let builder = MilBuilder::new("main").input("x", contract.dtype, input_shape);
        let builder = (contract.build)(builder)
            .expect("diagnostic graph build should succeed");
        builder.build().expect("MIL program build should succeed for diagnostic graph")
    }

    #[test]
    fn verifier_passes_valid_matmul() {
        let w: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
        let program = MilBuilder::new("main")
            .input("x", mil_spec::DataType::Float32, &[1, 4])
            .const_f32("w", &w, &[4, 1])
            .matmul("x", "w_0")
            .output("matmul_1")
            .build()
            .expect("build");

        let contract = DiagnosticGraphContract {
            name: "valid_matmul",
            description: "known-valid matmul for verifier test",
            track: "output_width",
            shape_k: 4,
            shape_n: 1,
            input_names: &["x"],
            output_names: &["matmul_1"],
            output_shapes: &[&[1, 1]],
            dtype: mil_spec::DataType::Float32,
            op_list: &["const", "matmul"],
            producer_map: &[("matmul_1", 1, "matmul", "matmul_1")],
            op_inputs: &[(1, "x", "x"), (1, "y", "w_0")],
            expected_fate: "expected_pass",
            build: |b| Ok(b),
        };

        let result = verify_graph_contract(&program, &contract);
        assert!(result.is_ok(), "valid matmul should pass verification: {:?}", result);
    }

    #[test]
    fn verifier_rejects_missing_output() {
        let w: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
        let program = MilBuilder::new("main")
            .input("x", mil_spec::DataType::Float32, &[1, 4])
            .const_f32("w", &w, &[4, 1])
            .matmul("x", "w_0")
            .output("matmul_1")
            .build()
            .expect("build");

        let contract = DiagnosticGraphContract {
            name: "missing_output",
            description: "contract expects nonexistent output",
            track: "output_width",
            shape_k: 4,
            shape_n: 1,
            input_names: &["x"],
            output_names: &["nonexistent"],
            output_shapes: &[&[1, 1]],
            dtype: mil_spec::DataType::Float32,
            op_list: &["const", "matmul"],
            producer_map: &[("nonexistent", 1, "matmul", "nonexistent")],
            op_inputs: &[(1, "x", "x"), (1, "y", "w_0")],
            expected_fate: "unknown",
            build: |b| Ok(b),
        };

        let result = verify_graph_contract(&program, &contract);
        assert!(result.is_err(), "should reject missing output");
        let errors = result.unwrap_err();
        assert!(
            errors.iter().any(|e| e.code == VerificationErrorCode::MissingOutput),
            "should contain MissingOutput error: {:?}",
            errors
        );
    }

    #[test]
    fn verifier_rejects_wrong_input_binding() {
        let w: Vec<f32> = (0..4).map(|i| (i + 1) as f32).collect();
        let good = MilBuilder::new("main")
            .input("x", mil_spec::DataType::Float32, &[1, 4])
            .const_f32("w", &w, &[4, 1])
            .matmul("x", "w_0")
            .output("matmul_1")
            .build()
            .expect("good build");
        let contract = DiagnosticGraphContract {
            name: "undef_input_check",
            description: "checking wrong input binding",
            track: "output_width",
            shape_k: 4,
            shape_n: 1,
            input_names: &["x"],
            output_names: &["matmul_1"],
            output_shapes: &[&[1, 1]],
            dtype: mil_spec::DataType::Float32,
            op_list: &["const", "matmul"],
            producer_map: &[("matmul_1", 1, "matmul", "matmul_1")],
            op_inputs: &[(1, "x", "nonexistent")],
            expected_fate: "unknown",
            build: |b| Ok(b),
        };
        let result = verify_graph_contract(&good, &contract);
        assert!(result.is_err(), "should reject wrong input binding");
        let errors = result.unwrap_err();
        assert!(
            errors.iter().any(|e| e.code == VerificationErrorCode::InputValueMismatch),
            "should contain InputValueMismatch error: {:?}",
            errors
        );
    }

    #[test]
    fn verifier_rejects_wrong_output_shape() {
        // Build a sigmoid_only graph, then verify with a bad contract.
        let contract = &ELEMENTWISE_GRAPHS[0]; // sigmoid_only
        let program = build_diagnostic_graph(contract);

        // Build a contract manually that expects the wrong shape.
        let bad_shape_contract = DiagnosticGraphContract {
            name: "bad_shape_test",
            description: "deliberately wrong output shape",
            track: "elementwise",
            shape_k: 4,
            shape_n: 1,
            input_names: &["x"],
            output_names: &["sig_0"],
            output_shapes: &[&[1, 99]],
            dtype: mil_spec::DataType::Float32,
            op_list: &["sigmoid"],
            producer_map: &[("sig_0", 0, "sigmoid", "sig_0")],
            op_inputs: &[(0, "x", "y")],
            expected_fate: "unknown",
            build: |b| Ok(b),
        };
        let result = verify_graph_contract(&program, &bad_shape_contract);
        assert!(result.is_err(), "should reject wrong output shape");
        let errors = result.unwrap_err();
        assert!(
            errors.iter().any(|e| e.code == VerificationErrorCode::WrongOutputShape),
            "should contain WrongOutputShape error: {:?}",
            errors
        );
    }

    #[test]
    fn all_diagnostic_graphs_are_structural() {
        for contract in all_diagnostic_graphs() {
            let result = build_and_verify(contract);
            assert!(
                result.is_ok(),
                "graph '{}' should pass structural verification: {:?}",
                contract.name,
                result
            );
        }
    }

    #[test]
    fn all_elementwise_graphs_build_and_verify() {
        for contract in ELEMENTWISE_GRAPHS {
            let result = build_and_verify(contract);
            assert!(
                result.is_ok(),
                "elementwise graph '{}' should pass verification: {:?}",
                contract.name,
                result
            );
        }
    }

    #[test]
    fn all_output_width_graphs_build_and_verify() {
        for contract in OUTPUT_WIDTH_GRAPHS {
            let result = build_and_verify(contract);
            assert!(
                result.is_ok(),
                "output_width graph '{}' should pass verification: {:?}",
                contract.name,
                result
            );
        }
    }

    #[test]
    fn error_codes_are_stable_strings() {
        for code in &[
            VerificationErrorCode::MissingOutput,
            VerificationErrorCode::WrongOutputShape,
            VerificationErrorCode::UndefinedOpInput,
            VerificationErrorCode::WrongOutputProducer,
            VerificationErrorCode::MissingValueType,
            VerificationErrorCode::ConstLengthMismatch,
            VerificationErrorCode::OutputNameNotFoundInOps,
            VerificationErrorCode::UnmappedBlockOutput,
            VerificationErrorCode::OpIndexOutOfRange,
            VerificationErrorCode::MissingProducerEntry,
            VerificationErrorCode::InputValueMismatch,
        ] {
            let s = format!("{}", code);
            assert!(!s.is_empty(), "code should have non-empty display");
            // Codes are snake_case stable identifiers.
            assert!(s.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "code '{}' should be snake_case", s);
        }
    }

    #[test]
    fn sigmoid_only_no_element_wise() {
        let program = build_diagnostic_graph(&ELEMENTWISE_GRAPHS[0]);
        let func = program.functions.get("main").unwrap();
        let block = func.block_specializations.get("CoreML9").unwrap();
        for op in &block.operations {
            assert_ne!(op.r#type, "element_wise", "sigmoid_only op should not have type 'element_wise'");
        }
    }

    #[test]
    fn sigmoid_mul_no_element_wise() {
        let program = build_diagnostic_graph(
            ELEMENTWISE_GRAPHS.iter().find(|c| c.name == "sigmoid_mul").unwrap()
        );
        let func = program.functions.get("main").unwrap();
        let block = func.block_specializations.get("CoreML9").unwrap();
        for op in &block.operations {
            assert_ne!(op.r#type, "element_wise", "sigmoid_mul op should not have type 'element_wise'");
        }
    }

    #[test]
    fn chain_matmul_add_silu_no_element_wise() {
        let contract = ELEMENTWISE_GRAPHS.iter()
            .find(|c| c.name == "chain_matmul_add_silu_small")
            .expect("chain_matmul_add_silu_small contract exists");
        let result = build_and_verify(contract);
        assert!(result.is_ok(), "chain_matmul_add_silu_small should pass verification: {:?}", result);
        let program = build_diagnostic_graph(contract);
        let func = program.functions.get("main").unwrap();
        let block = func.block_specializations.get("CoreML9").unwrap();
        for op in &block.operations {
            assert_ne!(op.r#type, "element_wise",
                "chain_matmul_add_silu_small op '{}' should not have type 'element_wise'", op.r#type);
        }
    }

    #[test]
    fn branch_scale_all_pass_structural() {
        for contract in BRANCH_SCALE_GRAPHS {
            let result = build_and_verify(contract);
            assert!(result.is_ok(), "{} should pass verification: {:?}", contract.name, result);
            let program = build_diagnostic_graph(contract);
            let func = program.functions.get("main").unwrap();
            let block = func.block_specializations.get("CoreML9").unwrap();
            for op in &block.operations {
                assert_ne!(op.r#type, "element_wise",
                    "{} op should not have type 'element_wise'", contract.name);
    }
        }
    }
}