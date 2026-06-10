//! Real-backend lowering adapters — prove the new compiler spine preserves
//! the already-qualified MLX, Accelerate, and Core ML routes.
//!
//! The Core ML lowering module provides the general-purpose
//! [`CoreMlLowering`] implementing [`BackendLowering`], replacing
//! the hardcoded `build_matmul_region` bypass.

pub mod dataset;
pub mod mlx;
pub mod accelerate;
pub mod coreml;
pub mod params;
pub mod receipts;

#[cfg(test)]
mod tests;

use crate::compiler::LoweringReceipt;
use crate::coreml_pipeline::CoreMlIslandReceipt;

/// Receipt produced by the Core ML lowering path (legacy compatibility).
#[derive(Debug)]
pub struct CoreMlLoweringReceipt {
    /// The compiler-level lowering receipt.
    pub lowering: LoweringReceipt,
    /// The full compilation island receipt from the pipeline.
    pub island_receipt: CoreMlIslandReceipt,
    /// Whether the `.mlmodelc` artifact exists on disk.
    pub artifact_exists: bool,
}
