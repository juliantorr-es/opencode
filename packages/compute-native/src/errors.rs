//! Structured error types for SharedTensorArena v1.
//!
//! Every error identifies the job, session, arena, and operation.

use crate::arena_lifecycle::LifecycleState;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ArenaError {
    pub job_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub arena_id: Option<String>,
    pub arena_generation: Option<u64>,
    pub current_state: Option<LifecycleState>,
    pub desired_transition: Option<LifecycleState>,
    pub backend: Option<&'static str>,
    pub operation: Option<&'static str>,
    pub model_id: Option<String>,
    pub kind: ArenaErrorKind,
}

#[derive(Debug, Clone)]
pub enum ArenaErrorKind {
    AllocationFailed {
        reason: String,
    },
    UnsupportedShape {
        dim0: u32,
        dim1: u32,
    },
    UnsupportedPixelFormat {
        format: i32,
    },
    LeaseConflict {
        held_by: Option<String>,
    },
    StaleGeneration {
        expected: u64,
        actual: u64,
    },
    MlxEvaluationFailed {
        details: String,
    },
    CoreMlPredictionFailed {
        code: i32,
        details: String,
    },
    StateConflict {
        state_id: Option<String>,
    },
    OutputBackingRejected {
        feature_name: String,
    },
    Cancelled {
        reason: String,
    },
    Timeout {
        deadline_ms: u64,
    },
    CleanupFailure {
        component: &'static str,
        reason: String,
    },
}

impl std::fmt::Display for ArenaErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArenaErrorKind::AllocationFailed { reason } => {
                write!(f, "allocation failed: {}", reason)
            }
            ArenaErrorKind::UnsupportedShape { dim0, dim1 } => {
                write!(f, "unsupported shape: {}x{}", dim0, dim1)
            }
            ArenaErrorKind::UnsupportedPixelFormat { format } => {
                write!(f, "unsupported pixel format: 0x{:X}", format)
            }
            ArenaErrorKind::LeaseConflict { held_by } => {
                if let Some(holder) = held_by {
                    write!(f, "lease conflict: held by {}", holder)
                } else {
                    write!(f, "lease conflict")
                }
            }
            ArenaErrorKind::StaleGeneration { expected, actual } => {
                write!(f, "stale generation: expected {}, got {}", expected, actual)
            }
            ArenaErrorKind::MlxEvaluationFailed { details } => {
                write!(f, "MLX evaluation failed: {}", details)
            }
            ArenaErrorKind::CoreMlPredictionFailed { code, details } => {
                write!(f, "Core ML prediction failed ({}): {}", code, details)
            }
            ArenaErrorKind::StateConflict { state_id } => {
                if let Some(id) = state_id {
                    write!(f, "state conflict: {}", id)
                } else {
                    write!(f, "state conflict")
                }
            }
            ArenaErrorKind::OutputBackingRejected { feature_name } => {
                write!(f, "output backing rejected for: {}", feature_name)
            }
            ArenaErrorKind::Cancelled { reason } => write!(f, "cancelled: {}", reason),
            ArenaErrorKind::Timeout { deadline_ms } => {
                write!(f, "timeout after {}ms", deadline_ms)
            }
            ArenaErrorKind::CleanupFailure { component, reason } => {
                write!(f, "cleanup failure in {}: {}", component, reason)
            }
        }
    }
}

impl std::fmt::Display for ArenaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] ", self.job_id)?;
        if let Some(backend) = self.backend {
            write!(f, "{}: ", backend)?;
        }
        if let Some(op) = self.operation {
            write!(f, "{}: ", op)?;
        }
        write!(f, "{}", self.kind)
    }
}

impl std::error::Error for ArenaError {}

impl ArenaError {
    pub fn new(kind: ArenaErrorKind) -> Self {
        ArenaError {
            job_id: None,
            session_id: None,
            arena_id: None,
            arena_generation: None,
            current_state: None,
            desired_transition: None,
            backend: None,
            operation: None,
            model_id: None,
            kind,
        }
    }

    pub fn with_job(mut self, id: Uuid) -> Self {
        self.job_id = Some(id);
        self
    }
    pub fn with_session(mut self, id: Uuid) -> Self {
        self.session_id = Some(id);
        self
    }
    pub fn with_arena(mut self, id: impl Into<String>) -> Self {
        self.arena_id = Some(id.into());
        self
    }
    pub fn with_backend(mut self, backend: &'static str) -> Self {
        self.backend = Some(backend);
        self
    }
    pub fn with_operation(mut self, op: &'static str) -> Self {
        self.operation = Some(op);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = ArenaError::new(ArenaErrorKind::LeaseConflict {
            held_by: Some("mlx".into()),
        })
        .with_job(Uuid::new_v4())
        .with_backend("coreml");
        let msg = format!("{}", err);
        assert!(msg.contains("lease conflict"));
        assert!(msg.contains("coreml"));
    }

    #[test]
    fn test_error_kind_variants() {
        let kinds = [
            ArenaErrorKind::AllocationFailed {
                reason: "oom".into(),
            },
            ArenaErrorKind::UnsupportedShape { dim0: 1, dim1: 1 },
            ArenaErrorKind::StaleGeneration {
                expected: 1,
                actual: 2,
            },
            ArenaErrorKind::Cancelled {
                reason: "shutdown".into(),
            },
        ];
        for k in &kinds {
            assert!(!format!("{}", k).is_empty());
        }
    }

    #[test]
    fn test_error_builder_pattern() {
        let err = ArenaError::new(ArenaErrorKind::Timeout { deadline_ms: 5000 })
            .with_job(Uuid::nil())
            .with_session(Uuid::nil())
            .with_arena("test-arena")
            .with_backend("mlx")
            .with_operation("eval");
        let msg = format!("{}", err);
        assert!(msg.contains("timeout"));
        assert!(msg.contains("mlx"));
        assert!(msg.contains("eval"));
    }
}
