//! Real-backend lowering adapters for Mission 0009 preservation gate.
//!
//! Each adapter lowers a scheduled F32 matmul region to a concrete
//! backend, executes the known-answer dataset, and verifies the
//! output contract against the semantic expectations.

pub mod dataset;
pub mod mlx;
pub mod accelerate;
pub mod coreml;

#[cfg(test)]
mod tests;
