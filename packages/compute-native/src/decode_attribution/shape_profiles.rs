//! Shape profile definitions — small, medium, large.
//!
//! These are applied to any graph family. The receipt carries both
//! `graph_family` and `shape_profile` as separate fields so topology
//! cost and shape scaling can be separated in reports.

/// A named shape profile with input and weight dimensions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShapeProfile {
    pub name: &'static str,
    pub input_rows: u32,
    pub input_cols: u32,
    pub weight_rows: u32,
    pub weight_cols: u32,
}

impl ShapeProfile {
    pub fn input_shape(&self) -> Vec<u32> {
        vec![1, self.input_cols]
    }
    pub fn weight_shape(&self) -> Vec<u32> {
        vec![self.weight_rows, self.weight_cols]
    }
    /// i64 version for MilBuilder::const_f32 which takes &[i64].
    pub fn weight_shape_i64(&self) -> Vec<i64> {
        vec![self.weight_rows as i64, self.weight_cols as i64]
    }
    pub fn input_shape_i64(&self) -> Vec<i64> {
        vec![1i64, self.input_cols as i64]
    }
}

/// Small: [1,4] × [4,1] — simplest nontrivial matmul.
pub const SMALL: ShapeProfile = ShapeProfile {
    name: "small",
    input_rows: 1,
    input_cols: 4,
    weight_rows: 4,
    weight_cols: 1,
};

/// Medium: [1,128] × [128,128] — typical hidden-size matmul.
pub const MEDIUM: ShapeProfile = ShapeProfile {
    name: "medium",
    input_rows: 1,
    input_cols: 128,
    weight_rows: 128,
    weight_cols: 128,
};

/// Large: [1,1024] × [1024,1024] — heavyweight matmul.
pub const LARGE: ShapeProfile = ShapeProfile {
    name: "large",
    input_rows: 1,
    input_cols: 1024,
    weight_rows: 1024,
    weight_cols: 1024,
};

/// All shape profiles in a slice for iteration.
pub const ALL_SHAPES: &[ShapeProfile] = &[SMALL, MEDIUM, LARGE];
