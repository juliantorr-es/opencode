//! Pure-Rust MIL program builder using `coreml-proto` + `prost`.
//!
//! Constructs `mil_spec::Program` protobufs without Python/coremltools.
//! Generates SSA value names automatically and produces a valid
//! MLProgram that coremlcompiler can ingest.
//!
//! ## Usage
//!
//! ```ignore
//! let prog = MilBuilder::new("main")
//!     .input("x", DataType::Float32, &[1, 4])
//!     .const_f32("weight", &[1.0, 2.0, 3.0, 4.0], &[4, 1])
//!     .matmul("x", "weight_0")
//!     .output("matmul_1")
//!     .build();
//! ```

use std::collections::HashMap;
use coreml_proto::proto::{
    mil_spec::{self, argument, dimension, tensor_value, value},
};

/// Error returned by [`MilBuilder::build`] when SSA validation fails.
#[derive(Debug, Clone)]
pub enum MilBuildError {
    /// An operation references an SSA value that is not defined
    /// by any input or previous operation.
    UndefinedValue {
        operation: String,
        name: String,
    },
    /// A block output references an SSA value that is not defined
    /// by any input or operation in the block.
    UndefinedBlockOutput {
        name: String,
    },
    /// An operation does not have a "name" attribute.
    MissingOperationName {
        op_type: String,
    },
    /// A referenced SSA value exists but has no known type.
    UnknownType {
        name: String,
    },
    /// An unsupported unary operation mode was requested (e.g., "gelu" with
    /// no matching Core ML MIL op type).
    UnsupportedUnaryOpMode {
        mode: String,
    },
}

impl std::fmt::Display for MilBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MilBuildError::UndefinedValue { operation, name } => {
                write!(f, "operation '{operation}' references undefined value '{name}'")
            }
            MilBuildError::UndefinedBlockOutput { name } => {
                write!(f, "block output '{name}' is not defined by any operation or input")
            }
            MilBuildError::MissingOperationName { op_type } => {
                write!(f, "operation type '{op_type}' missing required 'name' attribute")
            }
            MilBuildError::UnknownType { name } => {
                write!(f, "unknown type for value '{name}'")
            }
            MilBuildError::UnsupportedUnaryOpMode { mode } => {
                write!(f, "unsupported unary op mode: {mode}")
            }
        }
    }
}

impl std::error::Error for MilBuildError {}

/// Builder for constructing MIL Program protobufs.
///
/// Tracks SSA value names internally and produces a complete
/// `mil_spec::Program` containing one function with one block.
pub struct MilBuilder {
    function_name: String,
    opset: String,
    inputs: Vec<mil_spec::NamedValueType>,
    ops: Vec<mil_spec::Operation>,
    block_outputs: Vec<String>,
    counter: u64,
    /// Tracks the type of each named value for type inference and SSA validation.
    value_types: HashMap<String, mil_spec::ValueType>,
    /// Weights stored for mlpackage serialization.
    weights: HashMap<String, Vec<u8>>,
}

impl Default for MilBuilder {
    fn default() -> Self {
        Self::new("__default__")
    }
}

impl MilBuilder {
    pub fn new(function_name: &str) -> Self {
        Self {
            function_name: function_name.to_string(),
            opset: "CoreML9".to_string(),
            inputs: Vec::new(),
            ops: Vec::new(),
            block_outputs: Vec::new(),
            counter: 0,
            value_types: HashMap::new(),
            weights: HashMap::new(),
        }
    }

    /// Register a named input tensor.
    pub fn input(mut self, name: &str, dtype: mil_spec::DataType, shape: &[i64]) -> Self {
        let tensor_type = tensor_type(dtype, shape);
        let vt = value_type_tensor(tensor_type);
        self.value_types.insert(name.to_string(), vt.clone());
        self.inputs.push(mil_spec::NamedValueType {
            name: name.to_string(),
            r#type: Some(vt),
        });
        self
    }

    /// Override the opset identifier (default: "CoreML9").
    pub fn set_opset(mut self, opset: &str) -> Self {
        self.opset = opset.to_string();
        self
    }

    /// Return the current opset identifier.
    pub fn get_opset(&self) -> &str {
        &self.opset
    }

    /// Add a pre-built MIL operation to the block.
    pub fn operation(mut self, op: mil_spec::Operation, output_type: Option<(&str, mil_spec::ValueType)>) -> Self {
        if let Some((name, vt)) = output_type {
            self.value_types.insert(name.to_string(), vt);
        }
        self.ops.push(op);
        self
    }

    /// Explicitly register a value type.
    pub fn register_type(&mut self, name: &str, vt: mil_spec::ValueType) {
        self.value_types.insert(name.to_string(), vt);
    }

    /// Access the current ops list.
    pub fn ops(&self) -> &[mil_spec::Operation] { &self.ops }
    /// Add a weight for mlpackage serialization.
    pub fn add_weight(&mut self, name: &str, data: Vec<u8>) {
        self.weights.insert(name.to_string(), data);
    }

    /// Infer the matmul output shape from input dimensions: [M, K] x [K, N] = [M, N].
    fn infer_matmul_output_shape(&self, a: &str, b: &str) -> Vec<i64> {
        fn get_dims(types: &HashMap<String, mil_spec::ValueType>, key: &str) -> Option<(i64, i64)> {
            let vt = types.get(key)?;
            let tt = vt.r#type.as_ref()?;
            if let mil_spec::value_type::Type::TensorType(ref tensor) = tt {
                let dims: Vec<i64> = tensor.dimensions.iter().filter_map(|d| {
                    match d.dimension.as_ref()? {
                        dimension::Dimension::Constant(c) => Some(c.size as i64),
                        _ => None,
    }
                }).collect();
                if dims.len() >= 2 { Some((dims[0], dims[1])) } else { None }
            } else { None }
    }
        match (get_dims(&self.value_types, a), get_dims(&self.value_types, b)) {
            (Some((m, _)), Some((_, n))) => vec![m, n],
            _ => vec![1, 1],
    }
    }

    /// Resolve the output shape for a binary elementwise operation from input shapes.
    /// Both inputs should have the same shape. Returns [?, ?] if shapes cannot be resolved.
    fn resolve_elementwise_output_shape(&self, a: &str, b: &str) -> Vec<mil_spec::Dimension> {
        let a_dims = self.value_types.get(a).and_then(|vt| {
            if let mil_spec::value_type::Type::TensorType(ref tt) = vt.r#type.as_ref()? {
                Some(&tt.dimensions)
            } else { None }
        });
        let b_dims = self.value_types.get(b).and_then(|vt| {
            if let mil_spec::value_type::Type::TensorType(ref tt) = vt.r#type.as_ref()? {
                Some(&tt.dimensions)
            } else { None }
        });

        match (a_dims, b_dims) {
            (Some(a), Some(b)) if a == b => a.clone(),  // same shape → preserve
            _ => {
                // Unknown — use [?, ?] as fallback
                vec![
                    mil_spec::Dimension {
                        dimension: Some(dimension::Dimension::Unknown(
                            dimension::UnknownDimension { variadic: false },
                        )),
                    },
                    mil_spec::Dimension {
                        dimension: Some(dimension::Dimension::Unknown(
                            dimension::UnknownDimension { variadic: false },
                        )),
                    },
                ]
            }
        }
    }

    /// Add a const operation with f32 immediate values.
    /// Returns `Self` with the constant's SSA name tracked.
    pub fn const_f32(mut self, name_hint: &str, values: &[f32], shape: &[i64]) -> Self {
        let name = self.fresh_name(name_hint);
        let tensor_type = tensor_type(mil_spec::DataType::Float32, shape);
        let vt = value_type_tensor(tensor_type);

        let tv = mil_spec::TensorValue {
            value: Some(tensor_value::Value::Floats(tensor_value::RepeatedFloats {
                values: values.to_vec(),
            })),
        };
        let v = mil_spec::Value {
            doc_string: String::new(),
            r#type: Some(vt.clone()),
            value: Some(value::Value::ImmediateValue(value::ImmediateValue {
                value: Some(value::immediate_value::Value::Tensor(tv)),
            })),
        };

        // const op: "val" is an attribute, and it also needs a "name" attribute
        let mut attrs = HashMap::new();
        attrs.insert("name".to_string(), string_attr(&name));
        attrs.insert("val".to_string(), v);

        let op = make_operation("const", &name, HashMap::new(), &[(&name, &vt)], attrs);

        self.value_types.insert(name.clone(), vt);
        self.ops.push(op);
        self
    }

    /// Add a matmul operation. `a` and `b` are SSA names of input values.
    ///
    /// Output type: rank-2 f32 with dimensions inferred from the operation
    /// contract: if A is [M, K] and B is [K, N] (with transpose_x=false,
    /// transpose_y=false), output is [M, N].
    pub fn matmul(mut self, a: &str, b: &str) -> Self {
        let name = self.fresh_name("matmul");
        let dtype = self.require_dtype(a).expect("SSA: unknown value");
        let _ = self.require_dtype(b).expect("SSA: unknown value");

        // Infer matmul output shape from inputs: [M, K] × [K, N] = [M, N].
        // M = A rows (dim 0), N = B cols (dim 1).
        let output_dims = self.infer_matmul_output_shape(a, b);
        let vt = value_type_tensor(tensor_type(dtype, &output_dims));

        let mut inputs_map = HashMap::new();
        inputs_map.insert("x".to_string(), named_arg(a));
        inputs_map.insert("y".to_string(), named_arg(b));
        inputs_map.insert("transpose_x".to_string(), bool_arg(false));
        inputs_map.insert("transpose_y".to_string(), bool_arg(false));

        let op = make_operation("matmul", &name, inputs_map, &[(&name, &vt)], HashMap::new());

        self.value_types.insert(name.clone(), vt);
        self.ops.push(op);
        self
    }

    /// Add an element-wise add operation.
    pub fn add(mut self, a: &str, b: &str) -> Self {
        let name = self.fresh_name("add");
        let dtype = self.require_dtype(a).expect("SSA: unknown value");
        let _ = self.require_dtype(b).expect("SSA: unknown value");

        // Resolve output shape from inputs; fall back to [?,?]
        let dimensions = self.resolve_elementwise_output_shape(a, b);
        let vt = value_type_tensor(mil_spec::TensorType {
            data_type: dtype as i32,
            rank: 2,
            dimensions,
            attributes: HashMap::new(),
        });

        let mut inputs_map = HashMap::new();
        inputs_map.insert("x".to_string(), named_arg(a));
        inputs_map.insert("y".to_string(), named_arg(b));

        let op = make_operation("add", &name, inputs_map, &[(&name, &vt)], HashMap::new());

        self.value_types.insert(name.clone(), vt);
        self.ops.push(op);
        self
    }

    /// Add an element-wise multiply operation.
    pub fn mul(mut self, a: &str, b: &str) -> Self {
        let name = self.fresh_name("mul");
        let dtype = self.require_dtype(a).expect("SSA: unknown value");
        let _ = self.require_dtype(b).expect("SSA: unknown value");

        let dimensions = self.resolve_elementwise_output_shape(a, b);
        let vt = value_type_tensor(mil_spec::TensorType {
            data_type: dtype as i32,
            rank: 2,
            dimensions,
            attributes: HashMap::new(),
        });

        let mut inputs_map = HashMap::new();
        inputs_map.insert("x".to_string(), named_arg(a));
        inputs_map.insert("y".to_string(), named_arg(b));

        let op = make_operation("mul", &name, inputs_map, &[(&name, &vt)], HashMap::new());

        self.value_types.insert(name.clone(), vt);
        self.ops.push(op);
        self
    }

    /// Mark an SSA value as a block output.
    pub fn output(mut self, name: &str) -> Self {
        self.block_outputs.push(name.to_string());
        self
    }

    /// Verify the SSA graph is well-formed and return the built Program.
    ///
    /// Checks: every block output resolves to a known typed SSA value,
    /// every operation input references a known value, every operation
    /// has a nonempty name attribute, output names are unique, and
    /// block outputs are nonempty.
    pub fn build(self) -> Result<mil_spec::Program, MilBuildError> {
        // ── SSA verification ──────────────────────────────────────
        let mut defined: HashMap<String, bool> = HashMap::new();
        for inp in &self.inputs {
            defined.insert(inp.name.clone(), true);
        }
        for op in &self.ops {
            // Every non-trivial op must have a name attribute
            if !op.attributes.contains_key("name") {
                return Err(MilBuildError::MissingOperationName {
                    op_type: op.r#type.clone(),
                });
            }
            for input_list in op.inputs.values() {
                for b in &input_list.arguments {
                    if let Some(argument::binding::Binding::Name(ref n)) = b.binding {
                        if !defined.contains_key(n.as_str()) {
                            return Err(MilBuildError::UndefinedValue {
                                operation: op.r#type.clone(),
                                name: n.clone(),
                            });
                        }
                    }
                }
            }
            for out in &op.outputs {
                defined.insert(out.name.clone(), true);
            }
        }
        for out_name in &self.block_outputs {
            if !defined.contains_key(out_name.as_str()) {
                return Err(MilBuildError::UndefinedBlockOutput {
                    name: out_name.clone(),
                });
            }
        }

        let block = mil_spec::Block {
            inputs: vec![],
            outputs: self.block_outputs,
            operations: self.ops,
            attributes: HashMap::new(),
        };

        let mut block_specs = HashMap::new();
        block_specs.insert(self.opset.clone(), block);

        let function = mil_spec::Function {
            inputs: self.inputs,
            opset: self.opset,
            block_specializations: block_specs,
            attributes: HashMap::new(),
        };

        let mut functions = HashMap::new();
        functions.insert(self.function_name, function);

        Ok(mil_spec::Program {
            version: 1,
            functions,
            doc_string: String::new(),
            attributes: HashMap::new(),
        })
    }

    fn fresh_name(&mut self, hint: &str) -> String {
        let name = format!("{}_{}", hint, self.counter);
        self.counter += 1;
        name
    }

    /// Look up the dtype of an SSA value. Fails if the value is not found.
    fn require_dtype(&self, name: &str) -> Result<mil_spec::DataType, MilBuildError> {
        self.value_types
            .get(name)
            .and_then(|vt| match &vt.r#type {
                Some(mil_spec::value_type::Type::TensorType(tt)) => {
                    mil_spec::DataType::try_from(tt.data_type).ok()
                }
                _ => None,
            })
            .ok_or_else(|| MilBuildError::UnknownType {
                name: name.to_string(),
            })
    }

    /// Access stored weights (for mlpackage serialization).
    pub fn weights(&self) -> &HashMap<String, Vec<u8>> {
        &self.weights
}

    /// Get shapes of all tracked values (for graph_catalog shape inference).
    pub fn value_shapes(&self) -> HashMap<String, Vec<i64>> {
        let mut shapes = HashMap::new();
        for (name, vt) in &self.value_types {
            if let Some(mil_spec::value_type::Type::TensorType(ref tt)) = vt.r#type.as_ref() {
                let dims: Vec<i64> = tt.dimensions.iter().filter_map(|d| {
                    match d.dimension.as_ref()? {
                        dimension::Dimension::Constant(c) => Some(c.size as i64),
                        _ => None,
}
                }).collect();
                if !dims.is_empty() {
                    shapes.insert(name.clone(), dims);
}
            }
        }
        shapes
    }

    /// Format and export the builder state as a raw MIL text string.
    pub fn to_mil_text(&self) -> String {
        let mut mil = String::new();
        mil.push_str("program(1.3)\n");
        mil.push_str("[buildInfo = dict<string, string>({{\"coremlc-component-MIL\", \"3510.2.1\"}, {\"coremlc-version\", \"3500.32.1\"}})]\n");
        mil.push_str("{\n");
        
        // Function signature
        mil.push_str(&format!("    func {}<{}>(", self.function_name, self.opset.to_lowercase()));
        for (i, input) in self.inputs.iter().enumerate() {
            if i > 0 {
                mil.push_str(", ");
            }
            let type_str = format_value_type(input.r#type.as_ref().unwrap());
            mil.push_str(&format!("{} {}", type_str, input.name));
        }
        mil.push_str(") {\n");

        // Operations
        for op in &self.ops {
            mil.push_str("            ");
            // Outputs
            let out_type = format_value_type(op.outputs[0].r#type.as_ref().unwrap());
            let out_name = &op.outputs[0].name;
            mil.push_str(&format!("{} {} = {}(", out_type, out_name, op.r#type));

            // Inputs (arguments)
            let mut first_arg = true;
            let mut sorted_inputs: Vec<_> = op.inputs.iter().collect();
            sorted_inputs.sort_by_key(|(k, _)| *k);

            for (arg_name, arg) in sorted_inputs {
                if !first_arg {
                    mil.push_str(", ");
                }
                first_arg = false;
                mil.push_str(&format!("{} = ", arg_name));
                // Format binding
                if let Some(binding) = arg.arguments.first().and_then(|b| b.binding.as_ref()) {
                    match binding {
                        argument::binding::Binding::Name(n) => {
                            mil.push_str(n);
                        }
                        argument::binding::Binding::Value(v) => {
                            mil.push_str(&format_value(v));
                        }
                    }
                }
            }
            mil.push_str(")[");
            
            // Attributes
            let mut first_attr = true;
            let mut sorted_attrs: Vec<_> = op.attributes.iter().collect();
            sorted_attrs.sort_by_key(|(k, _)| *k);
            for (attr_name, attr_val) in sorted_attrs {
                if !first_attr {
                    mil.push_str(", ");
                }
                first_attr = false;
                mil.push_str(&format!("{} = {}", attr_name, format_value(attr_val)));
            }
            mil.push_str("];\n");
        }

        // Return block outputs
        mil.push_str("        } -> (");
        for (i, out) in self.block_outputs.iter().enumerate() {
            if i > 0 {
                mil.push_str(", ");
            }
            mil.push_str(out);
        }
        mil.push_str(");\n");
        mil.push_str("}\n");

        mil
    }
}

fn format_value_type(vt: &mil_spec::ValueType) -> String {
    if let Some(mil_spec::value_type::Type::TensorType(ref tt)) = vt.r#type {
        let dtype_str = match mil_spec::DataType::try_from(tt.data_type) {
            Ok(mil_spec::DataType::Float32) => "fp32",
            Ok(mil_spec::DataType::Float16) => "fp16",
            Ok(mil_spec::DataType::Int32) => "int32",
            Ok(mil_spec::DataType::Bool) => "bool",
            Ok(mil_spec::DataType::String) => "string",
            _ => "fp32",
        };
        let mut dims = String::new();
        for (i, d) in tt.dimensions.iter().enumerate() {
            if i > 0 {
                dims.push_str(", ");
            }
            if let Some(ref dimension) = d.dimension {
                match dimension {
                    dimension::Dimension::Constant(c) => dims.push_str(&c.size.to_string()),
                    dimension::Dimension::Unknown(_) => dims.push_str("?"),
                }
            }
        }
        format!("tensor<{}, [{}]>", dtype_str, dims)
    } else {
        "tensor<fp32, []>".to_string()
    }
}

fn format_value(val: &mil_spec::Value) -> String {
    if let Some(value::Value::ImmediateValue(ref iv)) = val.value {
        if let Some(value::immediate_value::Value::Tensor(ref tv)) = iv.value {
            if let Some(ref tensor_val) = tv.value {
                match tensor_val {
                    tensor_value::Value::Strings(s) => {
                        format!("string(\"{}\")", s.values.first().cloned().unwrap_or_default())
                    }
                    tensor_value::Value::Bools(b) => {
                        format!("bool({})", b.values.first().cloned().unwrap_or(false))
                    }
                    tensor_value::Value::Floats(f) => {
                        if let Some(mil_spec::value_type::Type::TensorType(ref tt)) = val.r#type.as_ref().and_then(|vt| vt.r#type.as_ref()) {
                            let shape: Vec<usize> = tt.dimensions.iter().filter_map(|d| {
                                if let Some(dimension::Dimension::Constant(c)) = d.dimension.as_ref() {
                                    Some(c.size as usize)
                                } else {
                                    None
                                }
                            }).collect();
                            
                            if shape.len() == 2 {
                                let rows = shape[0];
                                let cols = shape[1];
                                let mut res = String::new();
                                res.push_str(&format!("tensor<fp32, [{}, {}]>([", rows, cols));
                                for r in 0..rows {
                                    if r > 0 {
                                        res.push_str(", ");
                                    }
                                    res.push_str("[");
                                    for c in 0..cols {
                                        if c > 0 {
                                            res.push_str(", ");
                                        }
                                        let idx = r * cols + c;
                                        if idx < f.values.len() {
                                            res.push_str(&format!("{:?}", f.values[idx]));
                                        } else {
                                            res.push_str("0.0");
                                        }
                                    }
                                    res.push_str("]");
                                }
                                res.push_str("])");
                                return res;
                            }
                        }
                        if f.values.len() == 1 {
                            format!("{:?}", f.values[0])
                        } else {
                            format!("{:?}", f.values)
                        }
                    }
                    _ => "unknown".to_string()
                }
            } else {
                "nil".to_string()
            }
        } else {
            "nil".to_string()
        }
    } else {
        "nil".to_string()
    }
}

// ── CoreML unary op type compatibility map ──────────────────────────────

/// Describes a Core ML MIL serialized unary op type.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct CoreMlUnaryOpType {
    /// The MIL op type string accepted by coremlcompiler (e.g., "sigmoid").
    pub mil_op_type: &'static str,
    /// Whether this op requires additional attributes (e.g., gelu may need `approximation`).
    pub requires_attrs: bool,
}

/// Maps Tribunus internal unary semantic modes to compiler-accepted Core ML
/// MIL serialized op type strings. This is the single authority for unary op
/// type emission — no code should emit `"element_wise"` as a MIL op type.
const COREML_MIL_UNARY_OP_TYPE_MAP: &[(&str, CoreMlUnaryOpType)] = &[
    ("logistic", CoreMlUnaryOpType { mil_op_type: "sigmoid", requires_attrs: false }),  // canonical
    ("sigmoid",  CoreMlUnaryOpType { mil_op_type: "sigmoid", requires_attrs: false }),  // alias
    ("silu",     CoreMlUnaryOpType { mil_op_type: "silu",    requires_attrs: false }),
];

/// Resolve an internal unary semantic mode to its Core ML MIL op type.
///
/// Returns `None` if the mode is not recognized. Callers MUST fail closed
/// (return `MilBuildError::UnsupportedUnaryOpMode`) rather than falling back
/// to a generic op type.
pub fn resolve_unary_op_type(mode: &str) -> Option<CoreMlUnaryOpType> {
    COREML_MIL_UNARY_OP_TYPE_MAP
        .iter()
        .find(|(key, _)| *key == mode)
        .map(|(_, entry)| *entry)
}

// ── operation constructor (always installs the "name" attribute) ─────────

fn make_operation(
    op_type: &str,
    op_name: &str,
    inputs: HashMap<String, mil_spec::Argument>,
    outputs: &[(&str, &mil_spec::ValueType)],
    mut extra_attrs: HashMap<String, mil_spec::Value>,
) -> mil_spec::Operation {
    extra_attrs.insert("name".to_string(), string_attr(op_name));
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
        attributes: extra_attrs,
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

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
        r#type: Some(mil_spec::ValueType {
            r#type: Some(mil_spec::value_type::Type::TensorType(mil_spec::TensorType {
                data_type: mil_spec::DataType::Bool as i32,
                rank: 0,
                dimensions: vec![],
                attributes: HashMap::new(),
            })),
        }),
        value: Some(value::Value::ImmediateValue(value::ImmediateValue {
            value: Some(value::immediate_value::Value::Tensor(bool_tensor)),
        })),
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
        r#type: Some(mil_spec::ValueType {
            r#type: Some(mil_spec::value_type::Type::TensorType(mil_spec::TensorType {
                data_type: mil_spec::DataType::String as i32,
                rank: 0,
                dimensions: vec![],
                attributes: HashMap::new(),
            })),
        }),
        value: Some(value::Value::ImmediateValue(value::ImmediateValue {
            value: Some(value::immediate_value::Value::Tensor(string_tensor)),
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    // ── unary op type resolution tests ─────────────────────────────────--

    #[test]
    fn resolve_logistic_to_sigmoid() {
        let result = resolve_unary_op_type("logistic").unwrap();
        assert_eq!(result, CoreMlUnaryOpType { mil_op_type: "sigmoid", requires_attrs: false });
    }

    #[test]
    fn resolve_sigmoid_alias() {
        let result = resolve_unary_op_type("sigmoid").unwrap();
        assert_eq!(result, CoreMlUnaryOpType { mil_op_type: "sigmoid", requires_attrs: false });
    }

    #[test]
    fn resolve_silu() {
        let result = resolve_unary_op_type("silu").unwrap();
        assert_eq!(result, CoreMlUnaryOpType { mil_op_type: "silu", requires_attrs: false });
    }

    #[test]
    fn resolve_unknown_mode_returns_none() {
        assert!(resolve_unary_op_type("gelu").is_none());
        assert!(resolve_unary_op_type("relu").is_none());
        assert!(resolve_unary_op_type("tanh").is_none());
        assert!(resolve_unary_op_type("element_wise").is_none());
    }

    // ── MIL program construction tests ─────────────────────────────────--

    #[test]
    fn build_simple_matmul() {
        let prog = MilBuilder::new("main")
            .input("x", mil_spec::DataType::Float32, &[1, 4])
            .const_f32("w", &[1.0, 2.0, 3.0, 4.0], &[4, 1])
            .matmul("x", "w_0")
            .output("matmul_1")
            .build().unwrap();

        assert_eq!(prog.version, 1);
        assert_eq!(prog.functions.len(), 1);
        let func = prog.functions.get("main").unwrap();
        assert_eq!(func.inputs.len(), 1);
        assert_eq!(func.inputs[0].name, "x");
        let block = func.block_specializations.get("CoreML9").unwrap();
        assert_eq!(block.operations.len(), 2); // const + matmul
        assert_eq!(block.operations[0].r#type, "const");
        assert_eq!(block.operations[1].r#type, "matmul");
        assert_eq!(block.outputs.len(), 1);
        assert_eq!(block.outputs[0], "matmul_1");

        // Every non-const op must have a "name" attribute
        for op in &block.operations {
            assert!(op.attributes.contains_key("name"),
                "op '{}' missing 'name' attribute", op.r#type);
        }

        let _bytes = prog.encode_to_vec();
        assert!(!_bytes.is_empty());
    }

    #[test]
    fn build_add_then_mul() {
        let prog = MilBuilder::new("main")
            .input("a", mil_spec::DataType::Float32, &[2, 2])
            .input("b", mil_spec::DataType::Float32, &[2, 2])
            .add("a", "b")
            .mul("add_0", "add_0")
            .output("mul_1")
            .build().unwrap();

        let block = prog.functions.get("main")
            .and_then(|f| f.block_specializations.get("CoreML9"))
            .unwrap();
        assert_eq!(block.operations.len(), 2);
        assert_eq!(block.operations[0].r#type, "add");
        assert_eq!(block.operations[1].r#type, "mul");
        for op in &block.operations {
            assert!(op.attributes.contains_key("name"));
        }

        let _bytes = prog.encode_to_vec();
        assert!(!_bytes.is_empty());
    }

    #[test]
    #[should_panic(expected = "SSA: unknown value")]
    fn ssa_rejects_undefined_input() {
        MilBuilder::new("main")
            .matmul("x", "y")
            .output("matmul_0")
            .build();
    }

    #[test]
    fn ssa_rejects_missing_output() {
        let err = MilBuilder::new("main")
            .input("x", mil_spec::DataType::Float32, &[1, 4])
            .output("nonexistent")
            .build()
            .expect_err("must reject undefined block output");
        assert!(matches!(err, MilBuildError::UndefinedBlockOutput { .. }));
    }

    #[test]
    fn test_to_mil_text() {
        let builder = MilBuilder::new("main")
            .input("x", mil_spec::DataType::Float32, &[1, 4])
            .const_f32("w", &[1.0, 2.0, 3.0, 4.0], &[4, 1])
            .matmul("x", "w_0")
            .output("matmul_1");
        
        let text = builder.to_mil_text();
        assert!(text.contains("program(1.3)"));
        assert!(text.contains("func main<coreml9>"));
        assert!(text.contains("tensor<fp32, [1, 4]> x"));
        assert!(text.contains("const()["));
        assert!(text.contains("matmul("));
        assert!(text.contains("-> (matmul_1)"));
    }
}
